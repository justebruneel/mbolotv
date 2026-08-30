/* Mesure du débit réel des chaînes : déchiffre les locators de flux, puis
   télécharge 3 segments HLS par chaîne et calcule le bitrate (octets/s).
   N'affiche AUCUN identifiant de connexion. */
const { createDecipheriv, createHash } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const fs = require('node:fs');

const parse = (p) => (fs.existsSync(p) ? Object.fromEntries(
  fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
) : {});
// Clé de production : extraite du conteneur Docker (ctr-key.env, chmod 600)
const env = { ...parse(require('node:path').resolve(__dirname, '../../.env')), ...parse(require('node:path').resolve(__dirname, '.env')), ...parse('/tmp/opencode/ctr-key.env') };
const key = createHash('sha256').update(env.ENCRYPTION_KEY).digest();
function decrypt(buf) {
  const b = Buffer.from(buf);
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });

async function fetchMs(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' } });
    return res.ok ? res : null;
  } catch { return null; } finally { clearTimeout(t); }
}

async function measureHls(url, label) {
  const res = await fetchMs(url);
  if (!res) return { label, ok: false, err: 'manifest injoignable' };
  const ct = res.headers.get('content-type') || '';
  let text = await res.text();
  // Master playlist → prendre la première sous-playlist
  if (text.includes('#EXT-X-STREAM-INF')) {
    const line = text.split('\n').find((l, i, a) => l.startsWith('#EXT-X-STREAM-INF') && a[i + 1]?.trim());
    const next = text.split('\n').filter((l) => l && !l.startsWith('#'));
    const sub = next[0];
    if (!sub) return { label, ok: false, err: 'master vide' };
    return measureHls(new URL(sub, res.url).toString(), label);
  }
  if (!text.includes('#EXTINF')) return { label, ok: false, err: `pas du HLS (${ct.slice(0, 24) || 'type?'})` };
  const lines = text.split('\n');
  const base = new URL(res.url);
  const segs = [];
  for (let i = 0; i < lines.length - 1 && segs.length < 3; i++) {
    if (lines[i].startsWith('#EXTINF')) {
      const dur = parseFloat(lines[i].slice(8).split(',')[0]);
      const seg = lines[i + 1].trim();
      if (seg && !seg.startsWith('#')) segs.push({ dur, url: new URL(seg, base).toString() });
    }
  }
  if (!segs.length) return { label, ok: false, err: 'aucun segment' };
  let bytes = 0, dur = 0;
  for (const s of segs) {
    const r = await fetchMs(s.url, 15000);
    if (!r) continue;
    bytes += (await r.arrayBuffer()).byteLength;
    dur += s.dur;
  }
  if (!dur) return { label, ok: false, err: 'segments vides' };
  const mbps = (bytes * 8) / dur / 1e6;
  return { label, ok: true, mbps: mbps.toFixed(2), qualite: mbps > 6 ? 'FHD' : mbps > 3.5 ? 'HD' : mbps > 1.8 ? 'SD+' : 'SD', segments: segs.length };
}

(async () => {
  const sources = await prisma.source.findMany({ select: { id: true, name: true, kind: true, status: true } });
  console.log('sources:', sources.map((s) => `${s.name} [${s.kind}/${s.status}]`).join(' | '));

  const variants = await prisma.streamVariant.findMany({
    take: 60,
    include: { channel: { select: { name: true } } },
  });
  const candidates = variants.filter((v) => v.channel?.name).slice(0, 24);
  console.log('variantes testables:', candidates.length, '/', variants.length);
  // Échantillon varié : 6 chaînes réparties
  const picked = [];
  const step = Math.max(1, Math.floor(candidates.length / 6));
  for (let i = 0; i < candidates.length && picked.length < 6; i += step) picked.push(candidates[i]);

  for (const v of picked) {
    let url;
    try { url = decrypt(v.encryptedLocator); } catch { continue; }
    if (!/^https?:/.test(url)) continue;
    const r = await measureHls(url, v.channel.name.slice(0, 32));
    console.log(r.ok ? `✅ ${r.label.padEnd(34)} ${String(r.mbps).padStart(6)} Mbps  (${r.qualite}, ${r.segments} seg.)` : `❌ ${r.label.padEnd(34)} ${r.err}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e.message.slice(0, 300)); process.exit(1); });
