import { resolveRelay } from './relay.js';

const TEST_TIMEOUT_MS = 20_000;
const M3U_TIMEOUT_MS = 60_000;

function jsonOrError(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label} : réponse non-JSON`); }
}
function candidates(raw) {
  const value = new URL(raw);
  const origin = value.origin;
  const path = value.pathname.replace(/\/+$/, '');
  const roots = new Set(['']);
  if (/\/(portal|load)\.php$/i.test(path)) roots.add(path.replace(/\/(portal|load)\.php$/i, ''));
  else if (/\/c$/i.test(path)) roots.add(path.replace(/\/c$/i, ''));
  else roots.add(path);
  roots.add('/stalker_portal'); roots.add('/stalker_portal/server'); roots.add('/server');
  const out = [];
  for (const root of roots) for (const file of ['portal.php', 'load.php', 'server/load.php']) out.push(`${origin}${root.replace(/\/+$/, '')}/${file}`.replace(/\/+/g, '/').replace('https:/', 'https://').replace('http:/', 'http://'));
  if (/\/(portal|load)\.php$/i.test(path)) out.unshift(`${origin}${path}`);
  return [...new Set(out)];
}
async function request(env, url, headers, timeout = TEST_TIMEOUT_MS) {
  const target = resolveRelay(env, url);
  const response = await fetch(target.url, { headers: { ...headers, ...target.headers }, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}${body ? ` : ${body.slice(0, 100).replace(/\s+/g, ' ')}` : ''}`);
  return body;
}

export async function testSourceConnection(env, kind, connection) {
  const started = Date.now();
  if (kind === 'M3U') {
    const url = connection.url ?? connection.playlistUrl;
    if (!url) return { ok: false, latencyMs: null, error: 'URL de playlist manquante' };
    try {
      const body = await request(env, url, { 'user-agent': 'Mozilla/5.0', accept: 'application/vnd.apple.mpegurl, audio/x-mpegurl, text/plain, */*' }, M3U_TIMEOUT_MS);
      if (!/^\uFEFF?\s*#EXTM3U(?:\s|$)/i.test(body)) return { ok: false, latencyMs: Date.now() - started, error: 'La réponse ne contient pas d’en-tête #EXTM3U' };
      const playable = body.split(/\r?\n/).some((line) => /^https?:\/\//i.test(line.trim()));
      return { ok: playable, latencyMs: Date.now() - started, error: playable ? null : 'Playlist vide ou sans URL de lecture' };
    } catch (error) { return { ok: false, latencyMs: Date.now() - started, error: String(error?.message ?? error).slice(0, 300) }; }
  }
  if (kind === 'XTREAM') {
    const base = String(connection.url ?? '').replace(/\/+$/, '');
    if (!base || !connection.username || !connection.password) return { ok: false, latencyMs: null, error: 'URL, identifiant ou mot de passe manquant' };
    const query = new URLSearchParams({ username: connection.username, password: connection.password, action: 'get_live_streams' });
    try {
      const payload = jsonOrError(await request(env, `${base}/player_api.php?${query}`, { 'user-agent': 'Mozilla/5.0', accept: 'application/json, text/plain, */*' }, 60_000), 'Réponse Xtream');
      if (payload?.user_info && Number(payload.user_info.auth) === 0) return { ok: false, latencyMs: Date.now() - started, error: 'Identifiants Xtream invalides' };
      const items = Array.isArray(payload) ? payload : payload?.live_streams;
      return { ok: Array.isArray(items), latencyMs: Date.now() - started, error: Array.isArray(items) ? null : 'Réponse Xtream sans liste live' };
    } catch (error) { return { ok: false, latencyMs: Date.now() - started, error: String(error?.message ?? error).slice(0, 300) }; }
  }
  if (kind === 'MAC_PORTAL') {
    const raw = String(connection.url ?? connection.portal ?? '');
    const mac = String(connection.macAddress ?? connection.mac ?? connection.mac_address ?? '').trim().toUpperCase();
    if (!raw || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) return { ok: false, latencyMs: null, error: 'URL du portail ou adresse MAC invalide' };
    const origin = new URL(raw).origin;
    const headers = { MAC: mac, Cookie: `mac=${mac}; stb_lang=en; timezone=UTC`, Accept: 'application/json, text/javascript, */*; q=0.01', 'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 MAG254', 'X-User-Agent': 'Model: MAG254; Link: Ethernet', Referer: `${origin}/c/`, Origin: origin };
    const failures = [];
    for (const script of candidates(raw)) {
      try {
        const payload = jsonOrError(await request(env, `${script}?type=stb&action=handshake&token=&JsHttpRequest=1-json`, headers), 'Handshake Stalker');
        if (payload?.js?.token || payload?.token) return { ok: true, latencyMs: Date.now() - started, error: null };
        failures.push(`${new URL(script).pathname}: aucun token`);
      } catch (error) { failures.push(`${new URL(script).pathname}: ${String(error?.message ?? error).slice(0, 70)}`); }
    }
    return { ok: false, latencyMs: Date.now() - started, error: `Handshake Stalker refusé. ${failures.slice(-3).join(' | ')}`.slice(0, 300) };
  }
  return { ok: false, latencyMs: null, error: 'Type de source non supporté' };
}
