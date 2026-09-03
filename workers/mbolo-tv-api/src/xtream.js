import { resolveRelay } from './relay.js';

const MAX_API_BYTES = 50 * 1024 * 1024;
const CONNECTOR_TIMEOUT_MS = 180_000;
const FETCH_RETRIES = 3;
const FETCH_RETRY_DELAYS_MS = [800, 2500, 6000];
const INTER_CALL_DELAY_MS = 1_200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function summarizeBody(text) { const head = String(text ?? '').trim().slice(0, 120).replace(/\s+/g, ' '); return head || '(vide)'; }
function isAuthRejected(payload) { const info = payload && typeof payload === 'object' ? payload.user_info : null; return info && typeof info === 'object' && Number(info.auth) === 0; }
function normalizeIcon(icon) { if (!icon) return undefined; return icon.startsWith('//') ? `https:${icon}` : icon; }
function isFolderMarker(title) { return /^#{2,}.+#{2,}$/.test(title.trim()); }
function streamExtension(stream, connection) {
  const raw = String(stream.container_extension ?? connection.output ?? connection.streamExtension ?? 'm3u8').trim().replace(/^\./, '').toLowerCase();
  return ['m3u8', 'ts'].includes(raw) ? raw : 'm3u8';
}

async function fetchJson(url, env, touch) {
  let lastError;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
    if (touch) await touch().catch(() => undefined);
    const viaRelay = attempt >= 2 && env;
    const target = viaRelay ? resolveRelay(env, url) : { url, headers: {} };
    try {
      const response = await fetch(target.url, { signal: AbortSignal.timeout(CONNECTOR_TIMEOUT_MS), headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json, text/plain, */*', ...target.headers } });
      const text = await response.text();
      if (text.length > MAX_API_BYTES) throw new Error('Réponse Xtream trop volumineuse');
      if (!response.ok) throw new Error(`HTTP ${response.status}${text ? ` : ${summarizeBody(text)}` : ''}`);
      let payload;
      try { payload = JSON.parse(text); } catch { throw new Error(`Réponse non-JSON du panel${text.trim() ? ` : « ${summarizeBody(text)} »` : ' (corps vide)'}`); }
      if (isAuthRejected(payload)) throw new Error('Identifiants Xtream invalides (authentification refusée)');
      return payload;
    } catch (error) {
      lastError = error;
      if (/identifiants|HTTP 401|HTTP 403/i.test(String(error?.message ?? error))) throw error;
      if (attempt < FETCH_RETRIES) await sleep(FETCH_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Échec Xtream inconnu');
}

export async function fetchXtreamEntries(env, connection, touch) {
  const base = connection.url.replace(/\/+$/, '');
  const user = encodeURIComponent(connection.username);
  const pass = encodeURIComponent(connection.password);
  let categoryNames = new Map();
  try {
    const categories = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=get_live_categories`, env, touch);
    for (const category of Array.isArray(categories) ? categories : []) if (category.category_id != null && category.category_name) categoryNames.set(String(category.category_id), String(category.category_name).trim());
  } catch (error) {
    if (/identifiants|HTTP 401|HTTP 403/i.test(String(error?.message ?? error))) throw error;
  }
  await sleep(INTER_CALL_DELAY_MS);
  let payload;
  try { payload = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=get_live_streams`, env, touch); }
  catch (error) { throw new Error(`Échec de récupération du flux Xtream : ${error.message}`); }
  const streams = Array.isArray(payload) ? payload : Array.isArray(payload?.live_streams) ? payload.live_streams : [];
  if (streams.length === 0) throw new Error('Le panel Xtream a renvoyé une liste de chaînes vide, import conservé sans suppression');
  const entries = [];
  for (const stream of streams) {
    if (stream.stream_id == null || (stream.stream_type !== 'live' && stream.stream_type !== undefined)) continue;
    const title = String(stream.name ?? `Chaîne ${stream.num ?? stream.stream_id}`).trim();
    if (!title || isFolderMarker(title)) continue;
    const groupTitle = (stream.category_id != null && categoryNames.get(String(stream.category_id))) || (stream.category_name ? String(stream.category_name).trim() : undefined);
    entries.push({ title, tvgId: stream.epg_channel_id ? String(stream.epg_channel_id) : undefined, tvgLogo: normalizeIcon(stream.stream_icon), groupTitle, url: `${base}/live/${user}/${pass}/${stream.stream_id}.${streamExtension(stream, connection)}` });
  }
  if (entries.length === 0) throw new Error('Aucune chaîne live exploitable dans la réponse Xtream, import conservé sans suppression');
  return { entries };
}

async function fetchCategoryMap(env, base, user, pass, action, touch) {
  try {
    const payload = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=${action}`, env, touch);
    const map = new Map();
    for (const category of Array.isArray(payload) ? payload : []) if (category.category_id != null && category.category_name) map.set(String(category.category_id), String(category.category_name).trim());
    return map;
  } catch (error) {
    if (/identifiants|HTTP 401|HTTP 403/i.test(String(error?.message ?? error))) throw error;
    return new Map();
  }
}
function toRating(value) { const rating = Number(value); return Number.isFinite(rating) && rating >= 0 ? rating : null; }
function toAddedAt(value) { const added = Number(value); return Number.isFinite(added) && added > 0 ? new Date(added * 1000) : null; }

export async function fetchXtreamVodEntries(env, connection, touch) {
  const base = connection.url.replace(/\/+$/, '');
  const user = encodeURIComponent(connection.username);
  const pass = encodeURIComponent(connection.password);
  const movieCategories = await fetchCategoryMap(env, base, user, pass, 'get_vod_categories', touch);
  await sleep(INTER_CALL_DELAY_MS);
  const seriesCategories = await fetchCategoryMap(env, base, user, pass, 'get_series_categories', touch);
  await sleep(INTER_CALL_DELAY_MS);
  const vodPayload = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=get_vod_streams`, env, touch);
  await sleep(INTER_CALL_DELAY_MS);
  const seriesPayload = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=get_series`, env, touch);
  const vodStreams = Array.isArray(vodPayload) ? vodPayload : Array.isArray(vodPayload?.vod_streams) ? vodPayload.vod_streams : [];
  const seriesList = Array.isArray(seriesPayload) ? seriesPayload : Array.isArray(seriesPayload?.series) ? seriesPayload.series : [];
  const movies = [];
  for (const stream of vodStreams) {
    if (stream.stream_id == null) continue;
    const title = String(stream.name ?? `Film ${stream.stream_id}`).trim();
    if (!title || isFolderMarker(title)) continue;
    const containerExt = String(stream.container_extension ?? 'mp4').trim().replace(/^\./, '') || 'mp4';
    const categoryTitle = (stream.category_id != null && movieCategories.get(String(stream.category_id))) || (stream.category_name ? String(stream.category_name).trim() : undefined);
    movies.push({ kind: 'MOVIE', externalId: String(stream.stream_id), title, posterUrl: normalizeIcon(stream.stream_icon) ?? null, rating: toRating(stream.rating), categoryTitle: categoryTitle ?? null, containerExt, addedAt: toAddedAt(stream.added), locator: `${base}/movie/${user}/${pass}/${stream.stream_id}.${containerExt}` });
  }
  const series = [];
  for (const item of seriesList) {
    if (item.series_id == null) continue;
    const title = String(item.name ?? `Série ${item.series_id}`).trim();
    if (!title || isFolderMarker(title)) continue;
    const categoryTitle = (item.category_id != null && seriesCategories.get(String(item.category_id))) || (item.category_name ? String(item.category_name).trim() : undefined);
    series.push({ kind: 'SERIES', externalId: String(item.series_id), title, posterUrl: normalizeIcon(item.cover ?? item.stream_icon) ?? null, rating: toRating(item.rating), categoryTitle: categoryTitle ?? null, containerExt: null, addedAt: toAddedAt(item.last_modified ?? item.added), locator: JSON.stringify({ type: 'xtream-series', base, username: connection.username, password: connection.password, seriesId: String(item.series_id) }) });
  }
  return { movies, series };
}

export async function fetchXtreamSeriesInfo(env, connection, seriesId, touch) {
  const base = connection.url.replace(/\/+$/, '');
  const user = encodeURIComponent(connection.username);
  const pass = encodeURIComponent(connection.password);
  const payload = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=get_series_info&series_id=${encodeURIComponent(String(seriesId))}`, env, touch);
  if (typeof payload !== 'object' || payload === null) throw new Error('Réponse Xtream invalide (get_series_info)');
  const seasons = [];
  const declared = Array.isArray(payload.seasons) ? payload.seasons : [];
  const bySeason = payload.episodes && typeof payload.episodes === 'object' ? payload.episodes : {};
  const numbers = new Set(declared.map((season) => Number(season.season ?? season.season_number)).filter(Number.isFinite));
  for (const key of Object.keys(bySeason)) if (/^\d+$/.test(key)) numbers.add(Number(key));
  for (const number of [...numbers].sort((a, b) => a - b)) {
    const episodes = (Array.isArray(bySeason[String(number)]) ? bySeason[String(number)] : []).filter((episode) => episode?.id != null).map((episode) => ({ id: String(episode.id), num: Number(episode.episode_num ?? 0) || 0, title: episode.title != null ? String(episode.title).trim() : null, containerExt: String(episode.container_extension ?? 'mp4').trim().replace(/^\./, '') || 'mp4' })).sort((a, b) => a.num - b.num);
    seasons.push({ number, episodes });
  }
  return { seasons };
}
