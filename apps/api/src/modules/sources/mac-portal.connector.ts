import type { ParsedChannel } from './m3u.parser';
import { parseM3uStream } from './m3u.parser';
import { SafeFetcher } from './safe-fetcher';

export interface MacPortalConnection { url: string; macAddress?: string; signal?: AbortSignal; }
interface StalkerChannel { id?: number | string; name?: string; number?: number | string; logo?: string; genres?: Array<number | string> | number | string; genre_id?: number | string; }
interface StalkerGenre { id?: number | string; title?: string; }
const MAX_API_BYTES = 50 * 1024 * 1024;
const CONNECTOR_TIMEOUT_MS = 60_000;

type StalkerEnvelope<T> = { js?: T[] | { data?: T[]; results?: T[]; items?: T[] } };
function arrayFrom<T>(value: T[] | { data?: T[]; results?: T[]; items?: T[] } | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value?.data ?? value?.results ?? value?.items ?? [];
}

export async function fetchMacPortalEntries(connection: MacPortalConnection): Promise<{ entries: ParsedChannel[] }> {
  const fetcher = new SafeFetcher();
  const rawUrl = connection.url.trim();
  if (isM3uProvisioningUrl(rawUrl)) {
    const result = await fetcher.fetchStream(rawUrl, { maxBytes: 512 * 1024 * 1024, streamTimeoutMs: 300_000, signal: connection.signal });
    if (!result.ok || !result.stream) throw new Error(result.error ?? 'Playlist MAG/M3U inaccessible');
    const entries = await parseM3uStream(result.stream, { maxBytes: 512 * 1024 * 1024 });
    if (entries.length === 0) throw new Error('La playlist MAG/M3U ne contient aucune chaîne lisible');
    return { entries };
  }

  const base = normalizePortalBase(rawUrl);
  const mac = (connection.macAddress ?? extractMac(rawUrl)).trim().toUpperCase();
  if (!mac) throw new Error('Adresse MAC MAG manquante');
  const headers = {
    MAC: mac,
    Cookie: `mac=${mac};stb_lang=en;timezone=UTC`,
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'X-User-Agent': 'Model: MAG254; Link: Ethernet',
    Referer: `${base}/`,
    Origin: new URL(base).origin,
  };
  const endpoints = portalEndpoints(base);
  const { token, endpoint } = await getPortalToken(fetcher, endpoints, headers, connection.signal);
  const genresById = await getGenres(fetcher, endpoint, token, headers, connection.signal);
  const channelsUrl = `${endpoint}/portal.php?type=itv&action=get_all_channels&token=${encodeURIComponent(token)}&JsHttpRequest=1-json`;
  const channelsResult = await fetcher.fetch(channelsUrl, { maxBytes: MAX_API_BYTES, headers: { ...headers, Authorization: `Bearer ${token}` }, timeoutMs: CONNECTOR_TIMEOUT_MS, signal: connection.signal });
  if (!channelsResult.ok || !channelsResult.body) throw new Error(channelsResult.error ?? 'Récupération des chaînes Stalker refusée');
  let payload: StalkerEnvelope<StalkerChannel>;
  try { payload = JSON.parse(channelsResult.body.trim()) as StalkerEnvelope<StalkerChannel>; } catch { throw new Error('Réponse Stalker invalide'); }
  const channels = arrayFrom(payload.js);
  if (!channels.length) throw new Error('Le portail Stalker ne contient aucune chaîne');
  return {
    entries: channels.filter((channel) => channel.id != null).map((channel) => {
      const rawGenres = Array.isArray(channel.genres) ? channel.genres : channel.genres != null ? [channel.genres] : channel.genre_id != null ? [channel.genre_id] : [];
      const genre = rawGenres.length ? genresById.get(Number(rawGenres[0])) : undefined;
      return { title: String(channel.name ?? `Chaîne ${channel.number ?? channel.id}`).trim(), tvgLogo: channel.logo || undefined, groupTitle: genre, url: `${endpoint}/play/live/${token}/${channel.id}.ts` };
    }),
  };
}

function isM3uProvisioningUrl(value: string): boolean {
  try { const url = new URL(value); return /(?:^|\/)get\.php$/i.test(url.pathname) || ['m3u', 'm3u_plus'].includes((url.searchParams.get('type') ?? '').toLowerCase()); } catch { return false; }
}
function extractMac(value: string): string { try { const url = new URL(value); return url.searchParams.get('mac') ?? url.searchParams.get('mac_address') ?? ''; } catch { return ''; } }
function normalizePortalBase(value: string): string { const url = new URL(value); url.search = ''; if (/\/portal\.php$/i.test(url.pathname)) url.pathname = url.pathname.replace(/\/portal\.php$/i, ''); if (/\/c\/?$/i.test(url.pathname)) url.pathname = url.pathname.replace(/\/c\/?$/i, ''); return url.toString().replace(/\/$/, ''); }
function portalEndpoints(base: string): string[] {
  const url = new URL(base);
  const origin = url.origin;
  const candidates = [base, `${origin}/stalker_portal/server`, `${origin}/stalker_portal`, origin];
  return Array.from(new Set(candidates.map((value) => value.replace(/\/$/, ''))));
}

async function getPortalToken(fetcher: SafeFetcher, endpoints: string[], headers: Record<string, string>, signal?: AbortSignal): Promise<{ token: string; endpoint: string }> {
  let lastError = 'Handshake Stalker refusé';
  for (const endpoint of endpoints) {
    const handshake = await fetcher.fetch(`${endpoint}/portal.php?type=stb&action=handshake&token=&JsHttpRequest=1-json`, { headers, timeoutMs: CONNECTOR_TIMEOUT_MS, signal });
    if (!handshake.ok || !handshake.body) { lastError = handshake.error ?? lastError; continue; }
    try {
      const payload = JSON.parse(handshake.body) as { js?: { token?: string } };
      if (payload.js?.token) return { token: payload.js.token, endpoint };
    } catch { lastError = 'Handshake Stalker invalide'; }
  }
  throw new Error(lastError);
}

async function getGenres(fetcher: SafeFetcher, endpoint: string, token: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const result = await fetcher.fetch(`${endpoint}/portal.php?type=itv&action=get_genres&token=${encodeURIComponent(token)}&JsHttpRequest=1-json`, { headers: { ...headers, Authorization: `Bearer ${token}` }, timeoutMs: CONNECTOR_TIMEOUT_MS, signal });
    if (!result.ok || !result.body) return map;
    const payload = JSON.parse(result.body) as StalkerEnvelope<StalkerGenre>;
    for (const genre of arrayFrom(payload.js)) if (genre.id != null && genre.title) map.set(Number(genre.id), String(genre.title).trim());
  } catch { /* genres facultatifs */ }
  return map;
}
