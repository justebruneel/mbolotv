import type { ParsedChannel } from './m3u.parser';
import { parseM3uStream } from './m3u.parser';
import { SafeFetcher } from './safe-fetcher';

export interface MacPortalConnection { url: string; macAddress?: string; }
interface StalkerChannel { id?: number | string; name?: string; number?: number | string; logo?: string; genres?: Array<number | string>; }
interface StalkerGenre { id?: number | string; title?: string; }
const MAX_API_BYTES = 50 * 1024 * 1024;
const CONNECTOR_TIMEOUT_MS = 60_000;

export async function fetchMacPortalEntries(connection: MacPortalConnection): Promise<{ entries: ParsedChannel[] }> {
  const fetcher = new SafeFetcher();
  const rawUrl = connection.url.trim();
  if (isM3uProvisioningUrl(rawUrl)) {
    const result = await fetcher.fetchStream(rawUrl, { maxBytes: 512 * 1024 * 1024, streamTimeoutMs: 300_000 });
    if (!result.ok || !result.stream) throw new Error(result.error ?? 'Playlist MAG/M3U inaccessible');
    const entries = await parseM3uStream(result.stream, { maxBytes: 512 * 1024 * 1024 });
    if (entries.length === 0) throw new Error('La playlist MAG/M3U ne contient aucune chaîne lisible');
    return { entries };
  }

  const base = normalizePortalBase(rawUrl);
  const mac = (connection.macAddress ?? extractMac(rawUrl)).trim().toUpperCase();
  if (!mac) throw new Error('Adresse MAC MAG manquante');
  const headers = { MAC: mac, Cookie: `mac=${mac};stb_lang=en`, Accept: 'application/json' };
  const token = await getPortalToken(fetcher, base, headers);
  const genresById = await getGenres(fetcher, base, token, headers);
  const channelsResult = await fetcher.fetch(`${base}/portal.php?type=stb&action=get_all_channels&token=${encodeURIComponent(token)}&JsHttpRequest=1-json`, { maxBytes: MAX_API_BYTES, headers, timeoutMs: CONNECTOR_TIMEOUT_MS });
  if (!channelsResult.ok || !channelsResult.body) throw new Error(channelsResult.error ?? 'Récupération des chaînes Stalker refusée');
  let payload: { js?: StalkerChannel[] };
  try { payload = JSON.parse(channelsResult.body.trim()); } catch { throw new Error('Réponse Stalker invalide'); }
  const channels = Array.isArray(payload.js) ? payload.js : [];
  if (!channels.length) throw new Error('Le portail Stalker ne contient aucune chaîne');
  return { entries: channels.filter((channel) => channel.id != null).map((channel) => ({ title: String(channel.name ?? `Chaîne ${channel.number ?? channel.id}`).trim(), tvgLogo: channel.logo || undefined, groupTitle: Array.isArray(channel.genres) && channel.genres.length ? genresById.get(Number(channel.genres[0])) : undefined, url: `${base}/play/live/${token}/${channel.id}.ts` })) };
}

function isM3uProvisioningUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /(?:^|\/)get\.php$/i.test(url.pathname) || ['m3u', 'm3u_plus'].includes((url.searchParams.get('type') ?? '').toLowerCase());
  } catch { return false; }
}
function extractMac(value: string): string { try { return new URL(value).searchParams.get('mac') ?? ''; } catch { return ''; } }
function normalizePortalBase(value: string): string { const url = new URL(value); if (/\/portal\.php$/i.test(url.pathname)) url.pathname = url.pathname.replace(/\/portal\.php$/i, ''); if (/\/c\/?$/i.test(url.pathname)) url.pathname = url.pathname.replace(/\/c\/?$/i, ''); return url.toString().replace(/\/$/, ''); }

async function getPortalToken(fetcher: SafeFetcher, base: string, headers: Record<string, string>): Promise<string> { const handshake = await fetcher.fetch(`${base}/portal.php?type=stb&action=handshake&token=&JsHttpRequest=1-json`, { headers, timeoutMs: CONNECTOR_TIMEOUT_MS }); if (!handshake.ok || !handshake.body) throw new Error(handshake.error ?? 'Handshake Stalker refusé'); let payload: { js?: { token?: string } }; try { payload = JSON.parse(handshake.body); } catch { throw new Error('Handshake Stalker invalide'); } const token = payload.js?.token; if (!token) throw new Error('Token Stalker absent'); return token; }
async function getGenres(fetcher: SafeFetcher, base: string, token: string, headers: Record<string, string>): Promise<Map<number, string>> { const map = new Map<number, string>(); try { const result = await fetcher.fetch(`${base}/portal.php?type=stb&action=get_genres&token=${encodeURIComponent(token)}&JsHttpRequest=1-json`, { headers, timeoutMs: CONNECTOR_TIMEOUT_MS }); if (!result.ok || !result.body) return map; const payload: { js?: StalkerGenre[] } = JSON.parse(result.body); for (const genre of payload.js ?? []) if (genre.id != null && genre.title) map.set(Number(genre.id), String(genre.title).trim()); } catch { /* genres facultatifs */ } return map; }
