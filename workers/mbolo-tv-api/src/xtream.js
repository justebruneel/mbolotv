// Réplique de xtream.connector.ts : catégories + live_streams, URLs
// {base}/live/{user}/{pass}/{stream_id}.m3u8, rejet d'auth {"user_info":{"auth":0}}.
const MAX_API_BYTES = 50 * 1024 * 1024;
// Les panels IPTV débittent souvent à ~0,3 Mo/s : un catalogue de 24k chaînes
// (~11 Mo de JSON) prend ~40 s. 180 s laisse une marge confortable.
const CONNECTOR_TIMEOUT_MS = 180_000;

function isFolderMarker(title) {
  return /^#{2,}.+#{2,}$/.test(title.trim());
}

function normalizeIcon(icon) {
  if (!icon) return undefined;
  if (icon.startsWith('//')) return `https:${icon}`;
  return icon;
}

function isAuthRejected(payload) {
  if (typeof payload !== 'object' || payload === null) return false;
  const info = payload.user_info;
  return typeof info === 'object' && info !== null && Number(info.auth) === 0;
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(CONNECTOR_TIMEOUT_MS), headers: { 'user-agent': 'Mozilla/5.0' } });
  const text = await response.text();
  if (text.length > MAX_API_BYTES) throw new Error('Réponse Xtream trop volumineuse');
  return JSON.parse(text);
}

export async function fetchXtreamEntries(connection) {
  const base = connection.url.replace(/\/+$/, '');
  const user = encodeURIComponent(connection.username);
  const pass = encodeURIComponent(connection.password);

  let categoryNames = new Map();
  try {
    const categoryPayload = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=get_live_categories`);
    if (isAuthRejected(categoryPayload)) throw new Error('Identifiants Xtream invalides (authentification refusée)');
    for (const category of Array.isArray(categoryPayload) ? categoryPayload : []) {
      if (category.category_id != null && category.category_name) categoryNames.set(String(category.category_id), String(category.category_name).trim());
    }
  } catch (error) {
    if (String(error.message).includes('identifiants')) throw error;
  }

  let payload;
  try {
    payload = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=get_live_streams`);
  } catch (error) {
    throw new Error(error instanceof SyntaxError ? 'Réponse Xtream invalide (JSON attendu)' : `Échec de récupération du flux Xtream : ${error.message}`);
  }
  if (isAuthRejected(payload)) throw new Error('Identifiants Xtream invalides (authentification refusée)');

  const streams = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.live_streams)
      ? payload.live_streams
      : [];

  const entries = [];
  for (const stream of streams) {
    if (stream.stream_id == null || (stream.stream_type !== 'live' && stream.stream_type !== undefined)) continue;
    const title = String(stream.name ?? `Chaîne ${stream.num ?? stream.stream_id}`).trim();
    if (isFolderMarker(title)) continue;
    const groupTitle =
      (stream.category_id != null && categoryNames.get(String(stream.category_id)))
      || (stream.category_name ? String(stream.category_name).trim() : undefined);
    entries.push({
      title,
      tvgId: stream.epg_channel_id ? String(stream.epg_channel_id) : undefined,
      tvgLogo: normalizeIcon(stream.stream_icon),
      groupTitle,
      url: `${base}/live/${encodeURIComponent(connection.username)}/${encodeURIComponent(connection.password)}/${stream.stream_id}.m3u8`,
    });
  }
  return { entries };
}

// ---- VOD (films + séries) -------------------------------------------------
// Films : URL directe {base}/movie/{user}/{pass}/{id}.{ext}. Séries : pas
// d'URL exploitable sans get_series_info (1 requête fournisseur par série) —
// le locator stocké est un JSON résolu À LA LECTURE (cf. vod-play dans
// index.js), ce qui garde l'import léger quel que soit le nombre d'épisodes.

async function fetchCategoryMap(base, user, pass, action, connection) {
  try {
    const payload = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=${action}`);
    if (isAuthRejected(payload)) throw new Error('Identifiants Xtream invalides (authentification refusée)');
    const map = new Map();
    for (const category of Array.isArray(payload) ? payload : []) {
      if (category.category_id != null && category.category_name) map.set(String(category.category_id), String(category.category_name).trim());
    }
    return map;
  } catch (error) {
    // Catégories optionnelles : seul un refus d'authentification est bloquant.
    if (String(error.message).includes('identifiants')) throw error;
    void connection;
    return new Map();
  }
}

function toRating(value) {
  const rating = Number(value);
  return Number.isFinite(rating) && rating >= 0 ? rating : null;
}

function toAddedAt(value) {
  const added = Number(value);
  return Number.isFinite(added) && added > 0 ? new Date(added * 1000) : null;
}

export async function fetchXtreamVodEntries(connection) {
  const base = connection.url.replace(/\/+$/, '');
  const user = encodeURIComponent(connection.username);
  const pass = encodeURIComponent(connection.password);

  const movieCategories = await fetchCategoryMap(base, user, pass, 'get_vod_categories', connection);
  const seriesCategories = await fetchCategoryMap(base, user, pass, 'get_series_categories', connection);

  const vodPayload = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=get_vod_streams`);
  if (isAuthRejected(vodPayload)) throw new Error('Identifiants Xtream invalides (authentification refusée)');
  const seriesPayload = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=get_series`);
  if (isAuthRejected(seriesPayload)) throw new Error('Identifiants Xtream invalides (authentification refusée)');

  const vodStreams = Array.isArray(vodPayload) ? vodPayload : Array.isArray(vodPayload?.vod_streams) ? vodPayload.vod_streams : [];
  const seriesList = Array.isArray(seriesPayload) ? seriesPayload : Array.isArray(seriesPayload?.series) ? seriesPayload.series : [];

  const movies = [];
  for (const stream of vodStreams) {
    if (stream.stream_id == null) continue;
    const title = String(stream.name ?? `Film ${stream.stream_id}`).trim();
    if (isFolderMarker(title)) continue;
    const containerExt = (stream.container_extension ? String(stream.container_extension).trim().replace(/^\./, '') : '') || 'mp4';
    const categoryTitle =
      (stream.category_id != null && movieCategories.get(String(stream.category_id)))
      || (stream.category_name ? String(stream.category_name).trim() : undefined);
    movies.push({
      kind: 'MOVIE',
      externalId: String(stream.stream_id),
      title,
      posterUrl: normalizeIcon(stream.stream_icon) ?? null,
      rating: toRating(stream.rating),
      categoryTitle: categoryTitle ?? null,
      containerExt,
      addedAt: toAddedAt(stream.added),
      locator: `${base}/movie/${encodeURIComponent(connection.username)}/${encodeURIComponent(connection.password)}/${stream.stream_id}.${containerExt}`,
    });
  }

  const series = [];
  for (const item of seriesList) {
    if (item.series_id == null) continue;
    const title = String(item.name ?? `Série ${item.series_id}`).trim();
    if (isFolderMarker(title)) continue;
    const categoryTitle =
      (item.category_id != null && seriesCategories.get(String(item.category_id)))
      || (item.category_name ? String(item.category_name).trim() : undefined);
    series.push({
      kind: 'SERIES',
      externalId: String(item.series_id),
      title,
      posterUrl: normalizeIcon(item.cover ?? item.stream_icon) ?? null,
      rating: toRating(item.rating),
      categoryTitle: categoryTitle ?? null,
      containerExt: null,
      addedAt: toAddedAt(item.last_modified ?? item.added),
      // Locator JSON (pas d'URL directe) : déchiffré puis résolu en
      // get_series_info au moment du play / de la liste d'épisodes.
      locator: JSON.stringify({ type: 'xtream-series', base, username: connection.username, password: connection.password, seriesId: String(item.series_id) }),
    });
  }

  return { movies, series };
}

// Détail d'une série : saisons + épisodes (id, numéro, titre, extension).
// Appelé À LA LECTURE (fiche série / play d'un épisode) et mis en cache côté
// API — jamais à l'import, qui resterait sinon à 1 requête fournisseur/série.
export async function fetchXtreamSeriesInfo(connection, seriesId) {
  const base = connection.url.replace(/\/+$/, '');
  const user = encodeURIComponent(connection.username);
  const pass = encodeURIComponent(connection.password);
  const payload = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=get_series_info&series_id=${encodeURIComponent(String(seriesId))}`);
  if (isAuthRejected(payload)) throw new Error('Identifiants Xtream invalides (authentification refusée)');
  if (typeof payload !== 'object' || payload === null) throw new Error('Réponse Xtream invalide (get_series_info)');

  const seasons = [];
  const declaredSeasons = Array.isArray(payload.seasons) ? payload.seasons : [];
  const episodesBySeason = typeof payload.episodes === 'object' && payload.episodes !== null ? payload.episodes : {};
  const seasonNumbers = new Set(declaredSeasons.map((s) => Number(s.season ?? s.season_number)).filter((n) => Number.isFinite(n)));
  for (const key of Object.keys(episodesBySeason)) if (/^\d+$/.test(key)) seasonNumbers.add(Number(key));

  for (const number of [...seasonNumbers].sort((a, b) => a - b)) {
    const rawEpisodes = episodesBySeason[String(number)] ?? [];
    const episodes = (Array.isArray(rawEpisodes) ? rawEpisodes : [])
      .filter((episode) => episode?.id != null)
      .map((episode) => ({
        id: String(episode.id),
        num: Number(episode.episode_num ?? 0) || 0,
        title: episode.title != null ? String(episode.title).trim() : null,
        containerExt: episode.container_extension ? String(episode.container_extension).trim().replace(/^\./, '') : 'mp4',
      }))
      .sort((a, b) => a.num - b.num);
    seasons.push({ number, episodes });
  }
  return { seasons };
}
