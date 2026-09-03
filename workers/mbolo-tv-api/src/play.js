import { sha256Hex } from './crypto.js';
import { loadHiddenIds, categoryFilterSql } from './categories.js';
import { resolveRelay } from './relay.js';

export async function selectVariant(env, channelId, filterChannelId) {
  const params = [channelId];
  let filter = 'v."channelId" = $1';
  if (filterChannelId) { params.push(filterChannelId); filter += ` AND c.id = $${params.length}`; }
  const result = await env.db.query(env, `SELECT v.id, v."encryptedLocator", v."healthScore", v."healthStatus", s.status AS source_status, s.priority AS source_priority, s.priority FROM "StreamVariant" v JOIN "Source" s ON s.id = v."sourceId" JOIN "Channel" c ON c.id = v."channelId" WHERE ${filter} AND v."isActive" AND s.status <> 'DISABLED' ORDER BY v."healthScore" DESC, s.priority ASC`, params);
  return result.rows.find((row) => row.healthStatus !== 'DOWN') ?? result.rows[0] ?? null;
}
export async function assertGrantActive(env, deviceId) {
  if (!deviceId) return false;
  const result = await env.db.query(env, `SELECT g.id FROM "DeviceGrant" g JOIN "AccessCode" a ON a.id = g."accessCodeId" WHERE g."deviceHash" = $1 AND g."expiresAt" > now() AND a.active AND a."revokedAt" IS NULL LIMIT 1`, [await sha256Hex(deviceId)]);
  return result.rows.length > 0;
}
const SIGN_TTL_MS = 24 * 3_600_000;
const SIGN_BUCKET_MS = 3_600_000;
const nextExpiry = (now = Date.now()) => Math.floor(now / SIGN_BUCKET_MS) * SIGN_BUCKET_MS + SIGN_TTL_MS;
async function hmacHex(secret, payload) { const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)); return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
export async function playResponse(env, providerUrl, maxHeight, { qualityCap, direct } = {}) {
  const proxyUrl = String(env.VIDEO_PROXY_URL ?? '').trim().replace(/\/+$/, '');
  const secret = String(env.PROXY_URL_SECRET ?? '').trim();
  if (!proxyUrl || !secret) throw new Error('Proxy vidéo non configuré');
  const expiry = nextExpiry();
  const signature = await hmacHex(secret, `${providerUrl}|${expiry}`);
  let url = `${proxyUrl}/?url=${encodeURIComponent(providerUrl)}&x-exp=${expiry}&x-sig=${signature}`;
  if (direct) url += '&direct=1';
  if (maxHeight) url += `&maxh=${maxHeight}`;
  return { url, expiresAt: new Date(expiry).toISOString(), ...(qualityCap ? { qualityCap } : {}) };
}
export async function channelIsVisible(env, channelId) {
  const category = categoryFilterSql(await loadHiddenIds(env), null, 'c', 2);
  const result = await env.db.query(env, `SELECT 1 FROM "Channel" c WHERE c.id = $1 AND c."isVisible" = true AND EXISTS (SELECT 1 FROM "StreamVariant" v JOIN "Source" s ON s.id = v."sourceId" WHERE v."channelId" = c.id AND v."isActive" AND s.status <> 'DISABLED')${category.sql} LIMIT 1`, [channelId, ...category.params]);
  return result.rows.length > 0;
}

function scriptCandidates(value) {
  const input = new URL(value);
  input.search = ''; input.hash = '';
  const origin = input.origin;
  const path = input.pathname.replace(/\/+$/, '');
  const roots = new Set();
  if (/\/(portal|load)\.php$/i.test(path)) roots.add(path.replace(/\/(portal|load)\.php$/i, ''));
  else if (/\/c$/i.test(path)) roots.add(path.replace(/\/c$/i, ''));
  else roots.add(path);
  roots.add(''); roots.add('/server'); roots.add('/stalker_portal'); roots.add('/stalker_portal/server');
  const candidates = [];
  if (/\/(portal|load)\.php$/i.test(path)) candidates.push(`${origin}${path}`);
  for (const root of roots) for (const file of ['portal.php', 'server/load.php', 'load.php']) {
    const clean = String(root).replace(/\/+$/, '');
    const joined = file === 'server/load.php' && /\/server$/i.test(clean) ? `${clean}/load.php` : `${clean}/${file}`;
    candidates.push(`${origin}${joined.replace(/\/+/g, '/')}`);
  }
  return [...new Set(candidates)];
}
function apiUrl(script, params) { const url = new URL(script); for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value)); return url.toString(); }
function stalkerHeaders(mac, token) { return { MAC: mac, Cookie: `mac=${mac}; stb_lang=en; timezone=UTC`, Accept: 'application/json, text/javascript, */*; q=0.01', 'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 MAG254', 'X-User-Agent': 'Model: MAG254; Link: Ethernet', ...(token ? { Authorization: `Bearer ${token}` } : {}) }; }
async function fetchPortal(env, url, headers, timeout = 20_000) {
  const relayed = resolveRelay(env, url);
  const response = await fetch(relayed.url, { headers: { ...headers, ...relayed.headers }, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(await response.text());
}
export async function stalkerHandshake(env, baseOrScript, mac) {
  try {
    for (const script of scriptCandidates(baseOrScript)) {
      try {
        const payload = await fetchPortal(env, apiUrl(script, { type: 'stb', action: 'handshake', token: '', JsHttpRequest: '1-json' }), stalkerHeaders(mac));
        const token = payload?.js?.token ?? payload?.token;
        if (token) {
          const headers = stalkerHeaders(mac, String(token));
          try { await fetchPortal(env, apiUrl(script, { type: 'stb', action: 'get_profile', hd: 1, JsHttpRequest: '1-json' }), headers); } catch {}
          return { token: String(token), endpoint: script };
        }
      } catch { continue; }
    }
  } catch {}
  return null;
}
function cmdToUrl(cmd) {
  if (!cmd) return null;
  const match = /ffmpeg\s+(\S+)/.exec(String(cmd).trim());
  const url = (match ? match[1] : String(cmd).trim()).replace(/\\\//g, '/');
  if (!/^https?:\/\//i.test(url) || /(\?|&)stream=&/.test(url)) return null;
  return url;
}
async function stalkerCreateLink(env, script, cmd, token, mac) {
  try {
    const payload = await fetchPortal(env, apiUrl(script, { type: 'itv', action: 'create_link', cmd, JsHttpRequest: '1-json' }), stalkerHeaders(mac, token));
    return cmdToUrl(payload?.js?.cmd ?? payload?.cmd ?? '');
  } catch { return null; }
}
function channelArray(payload) { const value = payload?.js ?? payload; return Array.isArray(value) ? value : value?.data ?? value?.results ?? value?.items ?? []; }
async function fetchFreshCmd(env, script, token, mac, channelId) {
  try {
    const payload = await fetchPortal(env, apiUrl(script, { type: 'itv', action: 'get_all_channels', token, JsHttpRequest: '1-json' }), stalkerHeaders(mac, token), 30_000);
    const channel = channelArray(payload).find((item) => String(item.id) === String(channelId));
    return typeof channel?.cmd === 'string' ? channel.cmd.trim() : '';
  } catch { return ''; }
}
export async function resolveStalkerLocator(env, locator) {
  const parts = locator.split('|');
  if (parts.length < 3) return null;
  const [baseOrScript, mac, channelId, ...cmdParts] = parts;
  const storedCmd = cmdParts.join('|');
  const handshake = await stalkerHandshake(env, baseOrScript, mac);
  if (!handshake) return null;
  if (storedCmd) { const linked = await stalkerCreateLink(env, handshake.endpoint, storedCmd, handshake.token, mac); if (linked) return linked; }
  const freshCmd = await fetchFreshCmd(env, handshake.endpoint, handshake.token, mac, channelId);
  if (freshCmd) { const linked = await stalkerCreateLink(env, handshake.endpoint, freshCmd, handshake.token, mac); if (linked) return linked; const direct = cmdToUrl(freshCmd); if (direct) return direct; }
  return storedCmd ? cmdToUrl(storedCmd) : null;
}

export const _internal = { scriptCandidates, apiUrl, cmdToUrl, nextExpiry };
