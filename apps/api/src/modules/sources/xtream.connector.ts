import type { ParsedChannel } from './m3u.parser';
import { SafeFetcher } from './safe-fetcher';

export interface XtreamConnection {
  url: string;
  username: string;
  password: string;
}

interface XtreamLiveStream {
  num?: number | string;
  name?: string;
  stream_type?: string;
  stream_id?: number | string;
  stream_icon?: string;
  epg_channel_id?: string;
  category_id?: number | string;
  category_name?: string;
}

interface XtreamCategory {
  category_id?: number | string;
  category_name?: string;
}

const MAX_API_BYTES = 50 * 1024 * 1024;
// Certains serveurs Xtream sont lents à répondre (grosses listes de chaînes).
const CONNECTOR_TIMEOUT_MS = 60_000;

function isFolderMarker(title: string): boolean {
  return /^#{2,}.+#{2,}$/.test(title.trim());
}

function normalizeIcon(icon: string | undefined): string | undefined {
  if (!icon) return undefined;
  if (icon.startsWith('//')) return `https:${icon}`;
  return icon;
}

// Un serveur Xtream qui refuse les identifiants renvoie {"user_info":{"auth":0}}
// à la place de la liste. Il ne faut pas traiter ça comme une liste vide.
function isAuthRejected(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const info = (payload as { user_info?: { auth?: unknown } }).user_info;
  return typeof info === 'object' && info !== null && Number(info.auth) === 0;
}

export async function fetchXtreamEntries(connection: XtreamConnection): Promise<{ entries: ParsedChannel[] }> {
  const base = connection.url.replace(/\/+$/, '');
  const user = encodeURIComponent(connection.username);
  const pass = encodeURIComponent(connection.password);

  const fetcher = new SafeFetcher();

  const categoryResult = await fetcher.fetch(
    `${base}/player_api.php?username=${user}&password=${pass}&action=get_live_categories`,
    { maxBytes: MAX_API_BYTES, timeoutMs: CONNECTOR_TIMEOUT_MS },
  );
  const categoryNames = new Map<string, string>();
  if (categoryResult.ok && categoryResult.body !== undefined) {
    let payload: unknown;
    try {
      payload = JSON.parse(categoryResult.body);
    } catch {
      payload = undefined;
    }
    if (payload !== undefined && isAuthRejected(payload)) {
      throw new Error('Identifiants Xtream invalides (authentification refusée)');
    }
    const categories = Array.isArray(payload) ? (payload as XtreamCategory[]) : [];
    for (const category of categories) {
      if (category.category_id != null && category.category_name) {
        categoryNames.set(String(category.category_id), String(category.category_name).trim());
      }
    }
  }

  const apiUrl = `${base}/player_api.php?username=${user}&password=${pass}&action=get_live_streams`;

  const result = await fetcher.fetch(apiUrl, { maxBytes: MAX_API_BYTES, timeoutMs: CONNECTOR_TIMEOUT_MS });
  if (!result.ok || result.body === undefined) {
    throw new Error(result.error ?? 'Échec de récupération du flux Xtream');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.body);
  } catch {
    throw new Error('Réponse Xtream invalide (JSON attendu)');
  }

  if (isAuthRejected(payload)) {
    throw new Error('Identifiants Xtream invalides (authentification refusée)');
  }

  // Certains serveurs renvoient { live_streams: [...] }, d'autres un tableau direct [...]
  const streams = Array.isArray(payload)
    ? (payload as XtreamLiveStream[])
    : Array.isArray((payload as { live_streams?: unknown })?.live_streams)
      ? ((payload as { live_streams: XtreamLiveStream[] }).live_streams)
      : [];

  const entries: ParsedChannel[] = [];
  for (const stream of streams) {
    if (stream.stream_id == null || (stream.stream_type !== 'live' && stream.stream_type !== undefined)) {
      continue;
    }
    const title = String(stream.name ?? `Chaîne ${stream.num ?? stream.stream_id}`).trim();
    // Les marqueurs de dossiers (ex. "##### BEIN SPORTS #####") ne sont pas des chaînes.
    if (isFolderMarker(title)) {
      continue;
    }
    const groupTitle =
      (stream.category_id != null && categoryNames.get(String(stream.category_id))) ||
      (stream.category_name ? String(stream.category_name).trim() : undefined);
    entries.push({
      title,
      tvgId: stream.epg_channel_id ? String(stream.epg_channel_id) : undefined,
      tvgLogo: normalizeIcon(stream.stream_icon),
      groupTitle,
      url: `${base}/live/${user}/${pass}/${stream.stream_id}.m3u8`,
    });
  }

  return { entries };
}