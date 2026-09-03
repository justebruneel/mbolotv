import { SafeFetcher } from './safe-fetcher';

export interface XtreamVodConnection {
  url: string;
  username: string;
  password: string;
}

export interface VodEntry {
  kind: 'MOVIE' | 'SERIES';
  externalId: string;
  title: string;
  posterUrl: string | null;
  rating: number | null;
  categoryTitle: string | null;
  containerExt: string | null;
  addedAt: Date | null;
  locator: string;
}

interface XtreamVodStream {
  stream_id?: number | string;
  name?: string;
  stream_icon?: string;
  container_extension?: string;
  rating?: string | number;
  added?: string | number;
  category_id?: number | string;
  category_name?: string;
}

interface XtreamSerie {
  series_id?: number | string;
  name?: string;
  cover?: string;
  stream_icon?: string;
  rating?: string | number;
  last_modified?: string | number;
  added?: string | number;
  category_id?: number | string;
  category_name?: string;
}

interface XtreamCategory {
  category_id?: number | string;
  category_name?: string;
}

const MAX_API_BYTES = 50 * 1024 * 1024;
// Certains serveurs Xtream sont lents à répondre (grosses listes VOD).
const CONNECTOR_TIMEOUT_MS = 60_000;
// L'import du live ne doit pas être invalidé par un échec VOD.
export const VOD_INTER_CALL_DELAY_MS = 1_200;

function isFolderMarker(title: string): boolean {
  return /^#{2,}.+#{2,}$/.test(title.trim());
}

function normalizeIcon(icon: string | undefined): string | undefined {
  if (!icon) return undefined;
  if (icon.startsWith('//')) return `https:${icon}`;
  return icon;
}

function toRating(value: string | number | undefined): number | null {
  const rating = Number(value);
  return Number.isFinite(rating) && rating >= 0 ? rating : null;
}

function toAddedAt(value: string | number | undefined): Date | null {
  const added = Number(value);
  return Number.isFinite(added) && added > 0 ? new Date(added * 1000) : null;
}

// Un serveur Xtream qui refuse les identifiants renvoie {"user_info":{"auth":0}}
// à la place de la liste. Il ne faut pas traiter ça comme une liste vide.
function isAuthRejected(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const info = (payload as { user_info?: { auth?: unknown } }).user_info;
  return typeof info === 'object' && info !== null && Number(info.auth) === 0;
}

async function fetchCategoryMap(connection: XtreamVodConnection, action: string): Promise<Map<string, string>> {
  const base = connection.url.replace(/\/+$/, '');
  const user = encodeURIComponent(connection.username);
  const pass = encodeURIComponent(connection.password);
  const result = await new SafeFetcher().fetch(
    `${base}/player_api.php?username=${user}&password=${pass}&action=${action}`,
    { maxBytes: MAX_API_BYTES, timeoutMs: CONNECTOR_TIMEOUT_MS },
  );
  const map = new Map<string, string>();
  if (!result.ok || result.body === undefined) return map;
  let payload: unknown;
  try { payload = JSON.parse(result.body); } catch { return map; }
  if (isAuthRejected(payload)) throw new Error('Identifiants Xtream invalides (authentification refusée)');
  const categories = Array.isArray(payload) ? (payload as XtreamCategory[]) : [];
  for (const category of categories) {
    if (category.category_id != null && category.category_name) {
      map.set(String(category.category_id), String(category.category_name).trim());
    }
  }
  return map;
}

async function fetchVodList(connection: XtreamVodConnection, action: string, signal?: AbortSignal): Promise<unknown[]> {
  const base = connection.url.replace(/\/+$/, '');
  const user = encodeURIComponent(connection.username);
  const pass = encodeURIComponent(connection.password);
  const result = await new SafeFetcher().fetch(
    `${base}/player_api.php?username=${user}&password=${pass}&action=${action}`,
    { maxBytes: MAX_API_BYTES, timeoutMs: CONNECTOR_TIMEOUT_MS, signal },
  );
  if (!result.ok || result.body === undefined) {
    throw new Error(result.error ?? `Échec de récupération ${action}`);
  }
  let payload: unknown;
  try { payload = JSON.parse(result.body); } catch {
    throw new Error('Réponse Xtream invalide (JSON attendu)');
  }
  if (isAuthRejected(payload)) throw new Error('Identifiants Xtream invalides (authentification refusée)');
  // Certains serveurs renvoient { clé: [...] }, d'autres un tableau direct [...]
  if (Array.isArray(payload)) return payload;
  if (typeof payload === 'object' && payload !== null) {
    for (const value of Object.values(payload)) if (Array.isArray(value)) return value;
  }
  return [];
}

function mapVodMovie(stream: XtreamVodStream, movieCategories: Map<string, string>, base: string, user: string, pass: string): VodEntry | null {
  if (stream.stream_id == null) return null;
  const title = String(stream.name ?? `Film ${stream.stream_id}`).trim();
  if (!title || isFolderMarker(title)) return null;
  const containerExt = String(stream.container_extension ?? 'mp4').trim().replace(/^\./, '') || 'mp4';
  const categoryTitle =
    (stream.category_id != null && movieCategories.get(String(stream.category_id))) ||
    (stream.category_name ? String(stream.category_name).trim() : undefined);
  return {
    kind: 'MOVIE',
    externalId: String(stream.stream_id),
    title,
    posterUrl: normalizeIcon(stream.stream_icon) ?? null,
    rating: toRating(stream.rating),
    categoryTitle: categoryTitle ?? null,
    containerExt,
    addedAt: toAddedAt(stream.added),
    locator: `${base}/movie/${user}/${pass}/${stream.stream_id}.${containerExt}`,
  };
}

function mapVodSerie(item: XtreamSerie, seriesCategories: Map<string, string>, base: string, connection: XtreamVodConnection): VodEntry | null {
  if (item.series_id == null) return null;
  const title = String(item.name ?? `Série ${item.series_id}`).trim();
  if (!title || isFolderMarker(title)) return null;
  const categoryTitle =
    (item.category_id != null && seriesCategories.get(String(item.category_id))) ||
    (item.category_name ? String(item.category_name).trim() : undefined);
  return {
    kind: 'SERIES',
    externalId: String(item.series_id),
    title,
    posterUrl: normalizeIcon(item.cover ?? item.stream_icon) ?? null,
    rating: toRating(item.rating),
    categoryTitle: categoryTitle ?? null,
    containerExt: null,
    addedAt: toAddedAt(item.last_modified ?? item.added),
    locator: JSON.stringify({ type: 'xtream-series', base, username: connection.username, password: connection.password, seriesId: String(item.series_id) }),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Films + séries Xtream → entrées VOD normalisées (locator identique au Worker :
// /movie/... pour un film, JSON xtream-series pour une série — épisodes
// résolus à la lecture). Les catégories servent à résoudre categoryTitle.
export async function fetchXtreamVodEntries(
  connection: XtreamVodConnection,
  signal?: AbortSignal,
): Promise<{ movies: VodEntry[]; series: VodEntry[] }> {
  const base = connection.url.replace(/\/+$/, '');
  const movieCategories = await fetchCategoryMap(connection, 'get_vod_categories');
  await sleep(VOD_INTER_CALL_DELAY_MS);
  const seriesCategories = await fetchCategoryMap(connection, 'get_series_categories');
  await sleep(VOD_INTER_CALL_DELAY_MS);
  const vodStreams = (await fetchVodList(connection, 'get_vod_streams', signal)) as XtreamVodStream[];
  await sleep(VOD_INTER_CALL_DELAY_MS);
  const seriesList = (await fetchVodList(connection, 'get_series', signal)) as XtreamSerie[];

  const user = encodeURIComponent(connection.username);
  const pass = encodeURIComponent(connection.password);
  const movies: VodEntry[] = [];
  for (const stream of vodStreams) {
    const entry = mapVodMovie(stream, movieCategories, base, user, pass);
    if (entry) movies.push(entry);
  }
  const series: VodEntry[] = [];
  for (const item of seriesList) {
    const entry = mapVodSerie(item, seriesCategories, base, connection);
    if (entry) series.push(entry);
  }
  return { movies, series };
}
