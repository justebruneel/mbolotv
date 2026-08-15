import type { ParsedChannel } from './m3u.parser';
import { SafeFetcher } from './safe-fetcher';

export interface MacPortalConnection {
  url: string;
  macAddress: string;
}

interface StalkerChannel {
  id?: number | string;
  name?: string;
  number?: number | string;
  logo?: string;
  genres?: Array<number | string>;
}

interface StalkerGenre {
  id?: number | string;
  title?: string;
}

const MAX_API_BYTES = 50 * 1024 * 1024;

export async function fetchMacPortalEntries(connection: MacPortalConnection): Promise<{ entries: ParsedChannel[] }> {
  const base = connection.url.replace(/\/+$/, '');
  const mac = connection.macAddress.trim().toUpperCase();
  const fetcher = new SafeFetcher();
  const headers = { MAC: mac };

  const token = await getPortalToken(fetcher, base, headers);

  const genresById = await getGenres(fetcher, base, token, headers);

  const channelsResult = await fetcher.fetch(
    `${base}/portal.php?type=stb&action=get_all_channels&token=${encodeURIComponent(token)}&JsHttpRequest=1-xml`,
    { maxBytes: MAX_API_BYTES, headers },
  );
  if (!channelsResult.ok || channelsResult.body === undefined) {
    throw new Error(channelsResult.error ?? 'Récupération des chaînes refusée');
  }

  let payload: { js?: StalkerChannel[] };
  try {
    payload = JSON.parse(channelsResult.body);
  } catch {
    throw new Error('Réponse du portail invalide (JSON attendu)');
  }

  const channels = Array.isArray(payload.js) ? payload.js : [];
  const entries = channels
    .filter((channel) => channel.id != null)
    .map<ParsedChannel>((channel) => ({
      title: String(channel.name ?? `Chaîne ${channel.number ?? channel.id}`).trim(),
      tvgId: undefined,
      tvgLogo: channel.logo || undefined,
      groupTitle: Array.isArray(channel.genres) && channel.genres.length > 0 ? genresById.get(Number(channel.genres[0])) : undefined,
      url: `${base}/play/live/${token}/${channel.id}.ts`,
    }));

  return { entries };
}

async function getPortalToken(
  fetcher: SafeFetcher,
  base: string,
  headers: Record<string, string>,
): Promise<string> {
  const handshake = await fetcher.fetch(
    `${base}/portal.php?type=stb&action=handshake&token=&JsHttpRequest=1-xml`,
    { headers },
  );
  if (!handshake.ok || handshake.body === undefined) {
    throw new Error(handshake.error ?? 'Handshake du portail refusé');
  }
  let payload: { js?: { token?: string } };
  try {
    payload = JSON.parse(handshake.body);
  } catch {
    throw new Error('Handshake du portail invalide (JSON attendu)');
  }
  const token = payload.js?.token;
  if (!token) {
    throw new Error('Aucun token fourni par le portail');
  }
  return token;
}

async function getGenres(
  fetcher: SafeFetcher,
  base: string,
  token: string,
  headers: Record<string, string>,
): Promise<Map<number, string>> {
  const genresById = new Map<number, string>();
  try {
    const genresResult = await fetcher.fetch(
      `${base}/portal.php?type=stb&action=get_genres&token=${encodeURIComponent(token)}&JsHttpRequest=1-xml`,
      { headers },
    );
    if (!genresResult.ok || genresResult.body === undefined) return genresById;
    const payload: { js?: StalkerGenre[] } = JSON.parse(genresResult.body);
    if (Array.isArray(payload.js)) {
      for (const genre of payload.js) {
        if (genre.id != null && genre.title) {
          genresById.set(Number(genre.id), String(genre.title).trim());
        }
      }
    }
  } catch {
    // Les genres sont optionnels : catégories absentes si indisponibles.
  }
  return genresById;
}
