import { resolveRelay } from './relay.js';
import { parseM3uStream } from './m3u.js';

const MAX_API_BYTES = 50 * 1024 * 1024;
const CONNECTOR_TIMEOUT_MS = 90_000;
function arrayFrom(value) { if (Array.isArray(value)) return value; return value?.data ?? value?.results ?? value?.items ?? []; }
function isM3uProvisioningUrl(value) { try { const url = new URL(value); return /(?:^|\/)get\.php$/i.test(url.pathname) || ['m3u', 'm3u_plus'].includes((url.searchParams.get('type') ?? '').toLowerCase()); } catch { return false; } }
function extractMac(value) { try { const url = new URL(value); return url.searchParams.get('mac') ?? url.searchParams.get('mac_address') ?? ''; } catch { return ''; } }
function cleanInput(value) { const url = new URL(value.trim()); url.search = ''; url.hash = ''; return url; }
function portalScripts(value) {
  const input = cleanInput(value);
  const origin = input.origin;
  const pathname = input.pathname.replace(/\/+$/, '');
  const roots = new Set();
  if (/\/(portal|load)\.php$/i.test(pathname)) roots.add(pathname.replace(/\/(portal|load)\.php$/i, ''));
  else if (/\/c$/i.test(pathname)) roots.add(pathname.replace(/\/c$/i, ''));
  else roots.add(pathname);
  roots.add(''); roots.add('/stalker_portal'); roots.add('/stalker_portal/server'); roots.add('/server');
  const scripts = [];
  for (const root of roots) for (const file of ['portal.php', 'server/load.php', 'load.php']) {
    const normalizedRoot = String(root).replace(/\/+$/, '');
    const path = file === 'server/load.php' && /\/server$/i.test(normalizedRoot) ? `${normalizedRoot}/load.php` : `${normalizedRoot}/${file}`;
    scripts.push(`${origin}${path.replace(/\/+/g, '/')}`);
  }
  if (/\/(portal|load)\.php$/i.test(pathname)) scripts.unshift(`${origin}${pathname}`);
  return [...new Set(scripts)];
}
function apiUrl(script, params) { const url = new URL(script); for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value)); return url.toString(); }
async function stalkerFetch(env, url, headers, timeoutMs = CONNECTOR_TIMEOUT_MS) {
  const relayed = resolveRelay(env, url);
  const merged = new Headers(headers || {});
  for (const [name, value] of Object.entries(relayed.headers)) merged.set(name, value);
  const response = await fetch(relayed.url, { headers: merged, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text();
  if (body.length > MAX_API_BYTES) throw new Error('Réponse Stalker trop volumineuse');
  if (!response.ok) throw new Error(`HTTP ${response.status}${body ? ` : ${body.slice(0, 100).replace(/\s+/g, ' ')}` : ''}`);
  return body;
}
function parseEnvelope(body, label) { try { return JSON.parse(body.trim()); } catch { throw new Error(`${label} : réponse non-JSON`); } }

export async function fetchMacPortalEntries(env, connection) {
  const rawUrl = connection.url.trim();
  if (isM3uProvisioningUrl(rawUrl)) {
    const response = await fetch(rawUrl, { headers: { 'user-agent': 'Mozilla/5.0' }, redirect: 'follow', signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error(`Playlist MAG/M3U inaccessible (HTTP ${response.status})`);
    const entries = [];
    await parseM3uStream(response.body, (entry) => entries.push(entry), 512 * 1024 * 1024);
    if (entries.length === 0) throw new Error('La playlist MAG/M3U ne contient aucune chaîne lisible');
    return { entries };
  }

  const mac = (connection.macAddress ?? connection.mac ?? connection.mac_address ?? extractMac(rawUrl)).trim().toUpperCase();
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) throw new Error('Adresse MAC MAG invalide (format attendu 00:1A:79:XX:XX:XX)');
  const origin = cleanInput(rawUrl).origin;
  const headers = new Headers({ MAC: mac, Cookie: `mac=${mac}; stb_lang=en; timezone=UTC`, Accept: 'application/json, text/javascript, */*; q=0.01', 'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 MAG254', 'X-User-Agent': 'Model: MAG254; Link: Ethernet', Referer: `${origin}/c/`, Origin: origin });

  let token = '';
  let script = '';
  const failures = [];
  for (const candidate of portalScripts(rawUrl)) {
    try {
      const body = await stalkerFetch(env, apiUrl(candidate, { type: 'stb', action: 'handshake', token: '', JsHttpRequest: '1-json' }), headers, 20_000);
      const payload = parseEnvelope(body, 'Handshake Stalker invalide');
      const found = payload?.js?.token ?? payload?.token;
      if (found) { token = String(found); script = candidate; break; }
      failures.push(`${new URL(candidate).pathname}: aucun token`);
    } catch (error) { failures.push(`${new URL(candidate).pathname}: ${String(error?.message ?? error).slice(0, 80)}`); }
  }
  if (!token) throw new Error(`Handshake Stalker refusé. ${failures.slice(-3).join(' | ')}`);

  const authHeaders = new Headers(headers);
  authHeaders.set('Authorization', `Bearer ${token}`);
  // Beaucoup de portails n'autorisent get_all_channels qu'après get_profile.
  try { await stalkerFetch(env, apiUrl(script, { type: 'stb', action: 'get_profile', hd: 1, ver: 'ImageDescription: 0.2.18-r23-254; ImageDate: 18 Mar 2018; PORTAL version: 5.5.0; API Version: JS API version: 343; STB API version: 146', JsHttpRequest: '1-json' }), authHeaders, 20_000); } catch { /* profil facultatif selon le middleware */ }

  const genresById = new Map();
  try {
    const payload = parseEnvelope(await stalkerFetch(env, apiUrl(script, { type: 'itv', action: 'get_genres', token, JsHttpRequest: '1-json' }), authHeaders), 'Genres Stalker invalides');
    for (const genre of arrayFrom(payload.js ?? payload)) if (genre.id != null && genre.title) genresById.set(String(genre.id), String(genre.title).trim());
  } catch { /* genres facultatifs */ }

  const payload = parseEnvelope(await stalkerFetch(env, apiUrl(script, { type: 'itv', action: 'get_all_channels', token, JsHttpRequest: '1-json' }), authHeaders), 'Réponse Stalker invalide');
  const channels = arrayFrom(payload.js ?? payload);
  if (channels.length === 0) throw new Error('Le portail Stalker a renvoyé une liste vide, import conservé sans suppression');
  const entries = [];
  for (const channel of channels) {
    if (channel.id == null) continue;
    const cmd = typeof channel.cmd === 'string' ? channel.cmd.trim() : '';
    if (!cmd) continue;
    const genres = Array.isArray(channel.genres) ? channel.genres : channel.tv_genre_id != null ? [channel.tv_genre_id] : channel.genre_id != null ? [channel.genre_id] : [];
    const groupTitle = genres.length ? genresById.get(String(genres[0])) : undefined;
    const logo = typeof channel.logo === 'string' ? (channel.logo.startsWith('//') ? `https:${channel.logo}` : channel.logo) : undefined;
    entries.push({ title: String(channel.name ?? `Chaîne ${channel.number ?? channel.id}`).trim(), tvgLogo: logo, groupTitle: groupTitle ?? 'Chaînes TV', url: `${script}|${mac}|${channel.id}|${cmd}` });
  }
  if (entries.length === 0) throw new Error('Aucune chaîne Stalker exploitable (cmd absent), import conservé sans suppression');
  return { entries };
}

export const _internal = { portalScripts, apiUrl };
