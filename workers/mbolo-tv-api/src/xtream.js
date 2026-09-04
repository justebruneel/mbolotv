import { resolveRelay } from './relay.js';

const MAX_API_BYTES = 50 * 1024 * 1024;
// Catalogues volumineux en flux : la limite porte sur le volume cumulé
// téléchargé, pas sur la mémoire (lots de 500-1000 consommés au fil de l'eau).
const VOD_MAX_BYTES_DEFAULT = 1024 * 1024 * 1024;
const LIVE_MAX_BYTES_DEFAULT = 256 * 1024 * 1024;
const VOD_STREAM_IDLE_TIMEOUT_MS = 60_000;
const VOD_BATCH_SIZE = 500;
const LIVE_STREAM_BATCH_SIZE = 1000;
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
      const startedAt = Date.now();
      const response = await fetch(target.url, { signal: AbortSignal.timeout(CONNECTOR_TIMEOUT_MS), headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json, text/plain, */*', ...target.headers } });
      const text = await response.text();
      if (text.length > MAX_API_BYTES) throw new Error('Réponse Xtream trop volumineuse');
      if (!response.ok) throw new Error(`HTTP ${response.status}${text ? ` : ${summarizeBody(text)}` : ''}`);
      let payload;
      try { payload = JSON.parse(text); } catch { throw new Error(`Réponse non-JSON du panel${text.trim() ? ` : « ${summarizeBody(text)} »` : ' (corps vide)'}`); }
      if (isAuthRejected(payload)) throw new Error('Identifiants Xtream invalides (authentification refusée)');
      console.log(`[xtream] ${/action=([a-z_]+)/.exec(url)?.[1] ?? 'api'} OK (${Math.round((Date.now() - startedAt) / 1000)}s, ${Math.round(text.length / 1024)} Ko, ${viaRelay ? 'relais' : 'direct'})`);
      return payload;
    } catch (error) {
      console.log(`[xtream] ${/action=([a-z_]+)/.exec(url)?.[1] ?? 'api'} tentative ${attempt + 1}/${FETCH_RETRIES + 1} (${viaRelay ? 'relais' : 'direct'}) échec: ${String(error?.message ?? error).slice(0, 120)}`);
      lastError = error;
      // HTTP 403 : le plus souvent un blocage d'IP datacenter (pare-feu
      // fournisseur / Cloudflare « error code: 1003 »), pas un refus
      // d'identifiants → laisser le retry partir par le relais résidentiel.
      // Seuls 401 et l'auth=0 du panel (« identifiants ») court-circuitent.
      if (/identifiants|HTTP 401/i.test(String(error?.message ?? error))) throw error;
      if (attempt < FETCH_RETRIES) await sleep(FETCH_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Échec Xtream inconnu');
}

function mapLiveEntry(stream, categoryNames, base, user, pass, connection) {
  if (stream == null || typeof stream !== 'object') return null;
  if (stream.stream_id == null || (stream.stream_type !== 'live' && stream.stream_type !== undefined)) return null;
  const title = String(stream.name ?? `Chaîne ${stream.num ?? stream.stream_id}`).trim();
  if (!title || isFolderMarker(title)) return null;
  const groupTitle = (stream.category_id != null && categoryNames.get(String(stream.category_id))) || (stream.category_name ? String(stream.category_name).trim() : undefined);
  return { title, tvgId: stream.epg_channel_id ? String(stream.epg_channel_id) : undefined, tvgLogo: normalizeIcon(stream.stream_icon), groupTitle, url: `${base}/live/${user}/${pass}/${stream.stream_id}.${streamExtension(stream, connection)}` };
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
    if (/identifiants|HTTP 401/i.test(String(error?.message ?? error))) throw error;
  }
  await sleep(INTER_CALL_DELAY_MS);
  let payload;
  try { payload = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=get_live_streams`, env, touch); }
  catch (error) { throw new Error(`Échec de récupération du flux Xtream : ${error.message}`); }
  const streams = Array.isArray(payload) ? payload : Array.isArray(payload?.live_streams) ? payload.live_streams : [];
  if (streams.length === 0) throw new Error('Le panel Xtream a renvoyé une liste de chaînes vide, import conservé sans suppression');
  const entries = [];
  for (const stream of streams) {
    const entry = mapLiveEntry(stream, categoryNames, base, user, pass, connection);
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) throw new Error('Aucune chaîne live exploitable dans la réponse Xtream, import conservé sans suppression');
  return { entries };
}

// get_live_streams en flux : chaque lot (≤1000) est consommé par l'importeur
// dès réception — un catalogue de dizaines de milliers de chaînes ne transite
// jamais en mémoire (ni texte+JSON+tableau complets comme fetchXtreamEntries).
// Mêmes erreurs et même mapping que fetchXtreamEntries.
export async function fetchXtreamLiveBatches(env, connection, touch, onBatch) {
  const base = connection.url.replace(/\/+$/, '');
  const user = encodeURIComponent(connection.username);
  const pass = encodeURIComponent(connection.password);
  const categoryNames = new Map();
  try {
    const categories = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=get_live_categories`, env, touch);
    for (const category of Array.isArray(categories) ? categories : []) if (category.category_id != null && category.category_name) categoryNames.set(String(category.category_id), String(category.category_name).trim());
  } catch (error) {
    if (/identifiants|HTTP 401/i.test(String(error?.message ?? error))) throw error;
  }
  await sleep(INTER_CALL_DELAY_MS);
  const maxBytes = Number(env.IMPORT_LIVE_MAX_BYTES ?? LIVE_MAX_BYTES_DEFAULT);
  let emitted = 0;
  let mapped = 0;
  let pending = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const out = pending;
    pending = [];
    mapped += out.length;
    await onBatch(out);
  };
  try {
    await streamXtreamAction(`${base}/player_api.php?username=${user}&password=${pass}&action=get_live_streams`, env, touch, async (batch) => {
      emitted += batch.length;
      for (const stream of batch) {
        const entry = mapLiveEntry(stream, categoryNames, base, user, pass, connection);
        if (entry) pending.push(entry);
      }
      if (pending.length >= LIVE_STREAM_BATCH_SIZE) await flush();
    }, maxBytes);
  } catch (error) {
    throw new Error(`Échec de récupération du flux Xtream : ${error.message}`);
  }
  await flush();
  if (emitted === 0) throw new Error('Le panel Xtream a renvoyé une liste de chaînes vide, import conservé sans suppression');
  if (mapped === 0) throw new Error('Aucune chaîne live exploitable dans la réponse Xtream, import conservé sans suppression');
  return mapped;
}

async function fetchCategoryMap(env, base, user, pass, action, touch) {
  try {
    const payload = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=${action}`, env, touch);
    const map = new Map();
    for (const category of Array.isArray(payload) ? payload : []) if (category.category_id != null && category.category_name) map.set(String(category.category_id), String(category.category_name).trim());
    return map;
  } catch (error) {
    if (/identifiants|HTTP 401/i.test(String(error?.message ?? error))) throw error;
    return new Map();
  }
}
function toRating(value) { const rating = Number(value); return Number.isFinite(rating) && rating >= 0 ? rating : null; }
function toAddedAt(value) { const added = Number(value); return Number.isFinite(added) && added > 0 ? new Date(added * 1000) : null; }

// Parseur JSON incrémental : émet les éléments d'un tableau racine par lots
// sans bufferiser le corps de la réponse. Un panel de 100 000+ films renvoie
// une payload de plusieurs dizaines de Mo — response.text() + JSON.parse()
// dépasse la mémoire de l'isolate Workers et tue le waitUntil (run orphelin,
// import VOD qui n'aboutit jamais). Reconnaît [...] et {"clé":[…]}.
export async function streamJsonArrayBatches(body, onBatch, { maxBytes = MAX_API_BYTES, idleTimeoutMs = VOD_STREAM_IDLE_TIMEOUT_MS, batchSize = VOD_BATCH_SIZE } = {}) {
  if (!body) throw new Error('Réponse Xtream VOD vide');
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const reader = body.getReader();
  let received = 0;
  let buffer = '';
  let scanPos = 0;
  // seek : localise le tableau racine (éventuellement enveloppé dans un objet)
  // items : émission des éléments | done : tableau fermé, reste ignoré.
  let phase = 'seek';
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let pending = [];
  let emitted = 0;
  let done = false;

  const compact = (cut) => { buffer = cut >= buffer.length ? '' : buffer.slice(cut); scanPos -= cut; if (scanPos < 0) scanPos = 0; objectStart = objectStart >= 0 ? objectStart - cut : -1; };
  // Compactage au seuil : un buffer.slice() après CHAQUE objet coûte O(n²)
  // sur un catalogue de 100k+ items (l'isolate meurt en plein flux films,
  // CPU épuisé). On n'compacte que hors objet et tous les 2 Mo — la mémoire
  // reste bornée au dernier objet + seuil, le CPU devient linéaire.
  const maybeCompact = () => { if (objectStart < 0 && scanPos > 2_000_000) compact(scanPos); };
  // Flush strict : dès que le seuil est atteint, le lot part immédiatement —
  // aucun lot ne dépasse batchSize (pas de dépassement lié à la taille des
  // chunks réseau), ce qui borne la mémoire quelle que soit la source.
  const flushBatch = async () => {
    if (pending.length >= batchSize) {
      const batch = pending;
      pending = [];
      await onBatch(batch);
      emitted += batch.length;
    }
  };
  // Scanner : les caractères hors chaînes ne nous intéressent que
  // comme délimiteurs ; les chaînes sont sautées jusqu'à leur guillemet fermant
  // non échappé (les \" comptent, les \\\" non).
  const scan = async () => {
    for (;;) {
      if (inString) {
        let pos = scanPos;
        let closed = false;
        while (pos < buffer.length) {
          const quote = buffer.indexOf('"', pos);
          if (quote === -1) { scanPos = buffer.length; return; }
          let backslashes = 0;
          for (let i = quote - 1; i >= 0 && buffer[i] === '\\'; i -= 1) backslashes += 1;
          if (backslashes % 2 === 0) { inString = false; scanPos = quote + 1; closed = true; break; }
          pos = quote + 1;
        }
        if (!closed) return;
        continue;
      }
      let next = -1;
      for (let i = scanPos; i < buffer.length; i += 1) {
        const c = buffer[i];
        if (c === '"') { next = i; break; }
        if (c === '{' || c === '}' || c === '[' || c === ']') { next = i; break; }
      }
      if (next === -1) { scanPos = buffer.length; return; }
      const c = buffer[next];
      scanPos = next + 1;
      if (c === '"') { inString = true; continue; }
      if (phase === 'seek') {
        if (c === '[') { phase = 'items'; depth = 0; }
        else if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        continue;
      }
      if (c === '{') { if (depth === 0) objectStart = next; depth += 1; }
      else if (c === '[') { if (depth === 0) objectStart = next; depth += 1; }
      else if (c === '}') { depth -= 1; if (depth === 0 && objectStart >= 0) { push(buffer.slice(objectStart, next + 1)); compact(next + 1); await flushBatch(); maybeCompact(); } }
      else if (c === ']') {
        if (depth === 0) { phase = 'done'; return; }
        depth -= 1;
        if (depth === 0 && objectStart >= 0) { push(buffer.slice(objectStart, next + 1)); compact(next + 1); await flushBatch(); maybeCompact(); }
      }
    }
  };
  function push(raw) {
    try { pending.push(JSON.parse(raw)); } catch { /* élément tronqué ou invalide : ignoré */ }
    objectStart = -1;
  }

  try {
    for (;;) {
      let read;
      if (idleTimeoutMs > 0) {
        let timer;
        read = await Promise.race([
          reader.read(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Flux Xtream VOD interrompu (aucune donnée reçue)')), idleTimeoutMs); }),
        ]).finally(() => clearTimeout(timer));
      } else {
        read = await reader.read();
      }
      const { done: streamDone, value } = read;
      if (streamDone) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error(`Réponse Xtream VOD trop volumineuse (${received} octets, limite ${maxBytes})`);
      buffer += decoder.decode(value, { stream: true });
      await scan();
      if (done) break;
      await flushBatch();
    }
    await scan();
    if (pending.length > 0) { const batch = pending; pending = []; await onBatch(batch); emitted += batch.length; }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (done) await reader.cancel().catch(() => undefined);
  return emitted;
}

// Téléchargement en flux d'une action Xtream renvoyant une liste, avec une
// relance par le relais résidentiel si l'échec survient avant le premier
// élément (blocage datacenter 403/1003, réseau capricieux). Tentative 0 :
// direct ; tentative 1 : relais.
async function streamXtreamAction(url, env, touch, onBatch, maxBytes) {
  let lastError;
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    if (touch) await touch().catch(() => undefined);
    const viaRelay = attempt >= 1 && env;
    const target = viaRelay ? resolveRelay(env, url) : { url, headers: {} };
    try {
      const response = await fetch(target.url, { signal: AbortSignal.timeout(CONNECTOR_TIMEOUT_MS), headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json, text/plain, */*', ...target.headers } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await streamJsonArrayBatches(response.body, onBatch, { maxBytes });
    } catch (error) {
      lastError = error;
      // Même règle que fetchJson : 403 ≠ refus d'identifiants → relais.
      if (/identifiants|HTTP 401/i.test(String(error?.message ?? error))) throw error;
      if (attempt < 1) await sleep(2500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Échec Xtream inconnu');
}

// Synopsis fourni par le panel dans les listes VOD (champ plot), souvent
// tronqué mais gratuit : source de vérité, TVmaze/TMDB ne font que secourir.
function providerPlot(value) {
  const text = String(value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function mapVodMovie(stream, movieCategories, base, user, pass) {
  if (stream == null || typeof stream !== 'object' || stream.stream_id == null) return null;
  const title = String(stream.name ?? `Film ${stream.stream_id}`).trim();
  if (!title || isFolderMarker(title)) return null;
  const containerExt = String(stream.container_extension ?? 'mp4').trim().replace(/^\./, '') || 'mp4';
  const categoryTitle = (stream.category_id != null && movieCategories.get(String(stream.category_id))) || (stream.category_name ? String(stream.category_name).trim() : undefined);
  return { kind: 'MOVIE', externalId: String(stream.stream_id), title, posterUrl: normalizeIcon(stream.stream_icon) ?? null, rating: toRating(stream.rating), categoryTitle: categoryTitle ?? null, containerExt, addedAt: toAddedAt(stream.added), description: providerPlot(stream.plot), locator: `${base}/movie/${user}/${pass}/${stream.stream_id}.${containerExt}` };
}

function mapVodSerie(item, seriesCategories, connection) {
  if (item == null || typeof item !== 'object' || item.series_id == null) return null;
  const title = String(item.name ?? `Série ${item.series_id}`).trim();
  if (!title || isFolderMarker(title)) return null;
  const categoryTitle = (item.category_id != null && seriesCategories.get(String(item.category_id))) || (item.category_name ? String(item.category_name).trim() : undefined);
  return { kind: 'SERIES', externalId: String(item.series_id), title, posterUrl: normalizeIcon(item.cover ?? item.stream_icon) ?? null, rating: toRating(item.rating), categoryTitle: categoryTitle ?? null, containerExt: null, addedAt: toAddedAt(item.last_modified ?? item.added), description: providerPlot(item.plot), locator: JSON.stringify({ type: 'xtream-series', base: connection.url.replace(/\/+$/, ''), username: connection.username, password: connection.password, seriesId: String(item.series_id) }) };
}

// VOD (films + séries) en flux : chaque lot est consommé par l'importeur dès
// sa réception — le catalogue complet ne transite jamais en mémoire.
// Les séries (payload légère) sont récupérées AVANT les films : sur un relais
// résidentiel lent, elles atterrissent même si le flux des films est long.
// onMovies/onSeries reçoivent des lots d'entrées déjà normalisées.
// skipSeries/skipMovies : sous-phases déjà terminées (reprise par curseur) —
// le flux correspondant n'est même pas téléchargé.
export async function fetchXtreamVodBatches(env, connection, touch, { onMovies, onSeries }, { skipSeries = false, skipMovies = false, onPhaseDone } = {}) {
  const base = connection.url.replace(/\/+$/, '');
  const user = encodeURIComponent(connection.username);
  const pass = encodeURIComponent(connection.password);
  const maxBytes = Number(env.IMPORT_VOD_MAX_BYTES ?? VOD_MAX_BYTES_DEFAULT);
  if (!skipSeries) {
    const seriesCategories = await fetchCategoryMap(env, base, user, pass, 'get_series_categories', touch);
    await sleep(INTER_CALL_DELAY_MS);

    await streamXtreamAction(`${base}/player_api.php?username=${user}&password=${pass}&action=get_series`, env, touch, async (batch) => {
      const series = batch.map((item) => mapVodSerie(item, seriesCategories, connection)).filter(Boolean);
      if (series.length > 0) await onSeries(series);
    }, maxBytes);
    // Sous-phase séries terminée : marquée faite AVANT de démarrer le flux
    // des films (le plus lourd) — un isolate tué dessus converge à la reprise.
    if (onPhaseDone) await onPhaseDone('series').catch(() => undefined);
    await sleep(INTER_CALL_DELAY_MS);
  }

  if (!skipMovies) {
    const movieCategories = await fetchCategoryMap(env, base, user, pass, 'get_vod_categories', touch);
    await sleep(INTER_CALL_DELAY_MS);

    await streamXtreamAction(`${base}/player_api.php?username=${user}&password=${pass}&action=get_vod_streams`, env, touch, async (batch) => {
      const movies = batch.map((stream) => mapVodMovie(stream, movieCategories, base, user, pass)).filter(Boolean);
      if (movies.length > 0) await onMovies(movies);
    }, maxBytes);
    if (onPhaseDone) await onPhaseDone('movies').catch(() => undefined);
  }
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
