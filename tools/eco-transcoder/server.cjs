// Transcodeur éco Mbolo TV — réduit chaque chaîne IPTV à ~1 Mbps (480p)
// pour préserver la bande passante montante du relais résidentiel.
//
// Principe : un ffmpeg par chaîne demandée en mode éco, sortie HLS locale
// (segments 4 s, fenêtre 6 segments), servie au proxy edge via /hls/:id/.
// Auto-stop après IDLE_TIMEOUT_MS sans requête de lecture. Cap strict sur
// MAX_STREAMS : chaque ffmpeg coûte ~1 cœur sur cette machine.
//
// API de contrôle (token requis) :
//   POST /start  { channelId, srcUrl } → { ok, channelId, state, url }
//   POST /stop   { channelId }
//   GET  /status                       → liste des transcodages
//   GET  /health                       → liveness (sans token)
// Lecture HLS (publique, derrière le tunnel + signatures edge) :
//   GET /hls/:channelId/index.m3u8
//   GET /hls/:channelId/<segment>.ts
'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;

const PORT = Number(process.env.PORT || 8090);
const TOKEN = (process.env.ECO_TOKEN || '').trim();
const HLS_ROOT = process.env.HLS_ROOT || '/var/lib/mbolo-eco';
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS || 5 * 60_000);
const MAX_STREAMS = Number(process.env.MAX_STREAMS || 2);
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const READY_WAIT_MS = Number(process.env.READY_WAIT_MS || 10_000);

const CHANNEL_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SEGMENT_RE = /^[\w.-]+\.(ts|m3u8)$/;

const streams = new Map(); // channelId → { child, startedAt, lastAccessAt, state, logPath }
const sweeping = setInterval(sweep, 60_000);
sweeping.unref();

// ------------------------------- contrôle -------------------------------

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(req) {
  if (!TOKEN) return true; // dev local sans token
  return constantTimeEqual(req.headers['x-eco-token'], TOKEN);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 8192) reject(new Error('body trop grand'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) return isPrivateIp(h);
  if (h.includes(':')) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  try {
    const addrs = await dns.lookup(h, { all: true });
    return addrs.some((a) => isPrivateIp(a.address));
  } catch {
    return true; // hôte non résolvable → refus
  }
}

function isPrivateIp(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return true; // IPv6 non géré ici → refus prudent
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function startStream(channelId, srcUrl) {
  if (!CHANNEL_ID_RE.test(channelId)) throw Object.assign(new Error('channelId invalide'), { status: 400 });
  let url;
  try { url = new URL(srcUrl); } catch { throw Object.assign(new Error('srcUrl invalide'), { status: 400 }); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw Object.assign(new Error('protocole non autorisé'), { status: 400 });
  if (await isPrivateHost(url.hostname)) throw Object.assign(new Error('hôte privé refusé'), { status: 400 });

  const existing = streams.get(channelId);
  if (existing && existing.state !== 'exited') {
    existing.lastAccessAt = Date.now();
    return { ok: true, channelId, state: existing.state, reused: true };
  }
  if (streams.size >= MAX_STREAMS) {
    throw Object.assign(new Error(`capacité atteinte (${MAX_STREAMS} flux)`), { status: 503 });
  }

  const outDir = path.join(HLS_ROOT, channelId);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const logPath = path.join(outDir, 'ffmpeg.log');

  const args = [
    '-y', '-v', 'error',
    '-fflags', '+discardcorrupt+genpts', '-err_detect', 'ignore_err',
    '-i', url.toString(),
    '-map', '0:v:0', '-map', '0:a:0',
    '-vf', 'scale=854:480',
    '-c:v', 'libopenh264', '-b:v', '900k', '-maxrate', '1000k', '-bufsize', '1800k',
    '-rc_mode', 'bitrate', '-allow_skip_frames', '1',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_segment_filename', path.join(outDir, 'seg%d.ts'),
    path.join(outDir, 'index.m3u8'),
  ];

  const logFd = fs.openSync(logPath, 'w');
  const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd);

  const entry = { child, startedAt: Date.now(), lastAccessAt: Date.now(), state: 'starting', logPath };
  streams.set(channelId, entry);

  child.on('exit', (code) => {
    entry.state = 'exited';
    entry.exitCode = code;
    console.log(`[${new Date().toISOString()}] ffmpeg ${channelId} quitté (code ${code})`);
    // Les players en cours finissent leur buffer, puis le dossier disparaît :
    // la prochaine demande de lecture repassera par /start côté API.
    setTimeout(() => {
      if (streams.get(channelId) === entry) {
        streams.delete(channelId);
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    }, 30_000).unref();
  });

  // Attente courte du premier manifest pour que la 1ʳᵉ lecture ne soit pas blanche.
  const deadline = Date.now() + READY_WAIT_MS;
  while (Date.now() < deadline) {
    if (entry.state === 'exited') break;
    if (fs.existsSync(path.join(outDir, 'index.m3u8'))) { entry.state = 'ready'; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (entry.state !== 'exited' && entry.state !== 'ready') entry.state = 'starting';
  return { ok: entry.state !== 'exited', channelId, state: entry.state };
}

function stopStream(channelId) {
  const entry = streams.get(channelId);
  if (!entry) return { ok: false, error: 'flux inconnu' };
  entry.child.kill('SIGTERM');
  setTimeout(() => entry.child.killed || entry.child.kill('SIGKILL'), 3_000).unref();
  return { ok: true, channelId };
}

function statusOne(channelId, entry) {
  const playlistPath = path.join(HLS_ROOT, channelId, 'index.m3u8');
  let bitrateKbps = null;
  try {
    const playlist = fs.readFileSync(playlistPath, 'utf8');
    const segs = [...playlist.matchAll(/(seg\d+\.ts)\s*\n#EXTINF:(\d+(?:\.\d+)?)/g)];
    const last = segs[segs.length - 1];
    if (last) bitrateKbps = Math.round((fs.statSync(path.join(HLS_ROOT, channelId, last[1])).size * 8) / (Number(last[2]) * 1024));
  } catch { /* pas encore de playlist */ }
  return {
    channelId,
    state: entry.state,
    uptimeSec: Math.round((Date.now() - entry.startedAt) / 1000),
    idleSec: Math.round((Date.now() - entry.lastAccessAt) / 1000),
    bitrateKbps,
    exitCode: entry.exitCode ?? null,
  };
}

function sweep() {
  const now = Date.now();
  for (const [channelId, entry] of streams) {
    if (now - entry.lastAccessAt > IDLE_TIMEOUT_MS) {
      console.log(`[${new Date().toISOString()}] idle timeout → stop ${channelId}`);
      stopStream(channelId);
    }
  }
}

// ------------------------------- serveur HTTP -------------------------------

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

function serveHls(res, channelId, file) {
  if (!CHANNEL_ID_RE.test(channelId) || !SEGMENT_RE.test(file)) return send(res, 400, { error: 'chemin invalide' });
  const entry = streams.get(channelId);
  if (entry) entry.lastAccessAt = Date.now();
  const filePath = path.resolve(HLS_ROOT, channelId, file);
  if (!filePath.startsWith(path.resolve(HLS_ROOT, channelId) + path.sep)) return send(res, 400, { error: 'chemin invalide' });
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'flux éco indisponible');
    const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
    const cache = file.endsWith('.m3u8') ? 'no-store' : 'public, max-age=30';
    send(res, 200, data, { 'content-type': type, 'cache-control': cache });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, streams: streams.size });

    const hlsMatch = /^\/hls\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && hlsMatch) return serveHls(res, hlsMatch[1], hlsMatch[2]);

    if (!authorized(req)) return send(res, 401, { error: 'token invalide' });

    if (req.method === 'POST' && url.pathname === '/start') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = await startStream(String(body.channelId || ''), String(body.srcUrl || ''));
      return send(res, result.ok ? 200 : 502, result);
    }
    if (req.method === 'POST' && url.pathname === '/stop') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return send(res, 200, stopStream(String(body.channelId || '')));
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      return send(res, 200, { maxStreams: MAX_STREAMS, streams: [...streams.entries()].map(([id, entry]) => statusOne(id, entry)) });
    }
    send(res, 404, { error: 'route inconnue' });
  } catch (err) {
    send(res, err.status || 500, { error: err.message || 'erreur interne' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[${new Date().toISOString()}] éco-transcodeur sur 127.0.0.1:${PORT} (max ${MAX_STREAMS} flux, idle ${IDLE_TIMEOUT_MS / 1000}s, sortie ${HLS_ROOT})`);
});
