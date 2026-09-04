'use client';

import type { YoutubeListResponse, YoutubeVideo } from '@mbolo/contracts';

// Accès direct à YouTube Data v3 depuis le navigateur (onglet Nollywood).
// Pourquoi en direct et pas via nos serveurs ? Les egress serveurs
// (Cloudflare Workers, Vercel) reçoivent des 404 vides de l'edge Google
// sur ces endpoints, alors que les navigateurs passent : l'appel part donc
// du navigateur avec une clé PUBLIQUE restreinte (voir guide), jamais la clé
// serveur. Ordre d'appel : direct d'abord, proxy serveur en repli (au cas où
// le réseau de l'utilisateur bloquerait googleapis mais pas notre API).
// Quota : search = 100 unités/appel -> cache sessionStorage (30 min listes,
// 24 h fiches) + clé restreinte par referer au domaine de l'app.
// Chemins REST corrects : /search et /videos (search.list/videos.list,
// notation de la doc, répondent 404).
const YT_API = 'https://www.googleapis.com/youtube/v3';
const LIST_TTL_MS = 30 * 60_000;
const VIDEO_TTL_MS = 24 * 3600_000;

function publicKey(): string {
  return (process.env.NEXT_PUBLIC_YOUTUBE_API_KEY ?? '').trim();
}

interface CacheEntry {
  exp: number;
  data: YoutubeListResponse | YoutubeVideo;
}

function cacheGet(key: string): CacheEntry['data'] | null {
  try {
    const raw = window.sessionStorage.getItem(`ytapi:${key}`);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (!entry || typeof entry.exp !== 'number' || entry.exp < Date.now()) {
      window.sessionStorage.removeItem(`ytapi:${key}`);
      return null;
    }
    return entry.data ?? null;
  } catch {
    return null;
  }
}

function cacheSet(key: string, data: CacheEntry['data'], ttlMs: number): void {
  try {
    window.sessionStorage.setItem(`ytapi:${key}`, JSON.stringify({ exp: Date.now() + ttlMs, data }));
  } catch { /* stockage plein/bloqué : tant pis, sans cache */ }
}

function pickThumbnail(thumbnails: unknown): string | null {
  if (!thumbnails || typeof thumbnails !== 'object') return null;
  const record = thumbnails as Record<string, { url?: unknown }>;
  for (const quality of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const url = record[quality]?.url;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
  }
  return null;
}

async function directSearch(channelId: string, opts: { q?: string; pageToken?: string; maxResults: number }): Promise<YoutubeListResponse> {
  const key = publicKey();
  if (!key) throw new Error('Clé YouTube publique absente');
  const url = new URL(`${YT_API}/search`);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'video');
  url.searchParams.set('order', 'date');
  url.searchParams.set('channelId', channelId);
  url.searchParams.set('maxResults', String(opts.maxResults));
  if (opts.q) url.searchParams.set('q', opts.q);
  if (opts.pageToken) url.searchParams.set('pageToken', opts.pageToken);
  url.searchParams.set('key', key);
  const response = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!response.ok) {
    if (response.status === 403) throw new Error('Quota YouTube épuisé, réessayez plus tard');
    throw new Error(`YouTube a répondu ${response.status}`);
  }
  const payload = (await response.json()) as {
    items?: Array<{ id?: { videoId?: unknown }; snippet?: { title?: unknown; description?: unknown; publishedAt?: unknown; thumbnails?: unknown } }>;
    nextPageToken?: unknown;
  };
  const items = (Array.isArray(payload?.items) ? payload.items : [])
    .map((entry): YoutubeVideo | null => {
      const videoId = entry?.id?.videoId;
      if (typeof videoId !== 'string' || !videoId) return null;
      return {
        id: videoId,
        title: typeof entry.snippet?.title === 'string' ? entry.snippet.title : 'Sans titre',
        description: typeof entry.snippet?.description === 'string' ? entry.snippet.description : null,
        posterUrl: pickThumbnail(entry.snippet?.thumbnails),
        publishedAt: typeof entry.snippet?.publishedAt === 'string' ? entry.snippet.publishedAt : null,
        duration: null,
      };
    })
    .filter((entry): entry is YoutubeVideo => entry !== null);
  return { items, nextPageToken: typeof payload?.nextPageToken === 'string' ? payload.nextPageToken : null };
}

async function directVideo(videoId: string): Promise<YoutubeVideo> {
  const key = publicKey();
  if (!key) throw new Error('Clé YouTube publique absente');
  const url = new URL(`${YT_API}/videos`);
  url.searchParams.set('part', 'snippet,contentDetails');
  url.searchParams.set('id', videoId);
  url.searchParams.set('key', key);
  const response = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!response.ok) {
    if (response.status === 403) throw new Error('Quota YouTube épuisé, réessayez plus tard');
    throw new Error(`YouTube a répondu ${response.status}`);
  }
  const payload = (await response.json()) as {
    items?: Array<{ snippet?: { title?: unknown; description?: unknown; publishedAt?: unknown; thumbnails?: unknown }; contentDetails?: { duration?: unknown } }>;
  };
  const item = Array.isArray(payload?.items) ? payload.items[0] : null;
  if (!item) throw new Error('Vidéo introuvable');
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(item.contentDetails?.duration ?? ''));
  return {
    id: videoId,
    title: typeof item.snippet?.title === 'string' ? item.snippet.title : 'Sans titre',
    description: typeof item.snippet?.description === 'string' ? item.snippet.description : null,
    posterUrl: pickThumbnail(item.snippet?.thumbnails),
    publishedAt: typeof item.snippet?.publishedAt === 'string' ? item.snippet.publishedAt : null,
    duration: match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : null,
  };
}

function proxyListParams(channelId: string, opts: { q?: string; pageToken?: string; maxResults: number }): URLSearchParams {
  const params = new URLSearchParams({ channel: channelId, limit: String(opts.maxResults) });
  if (opts.q) params.set('q', opts.q);
  if (opts.pageToken) params.set('pageToken', opts.pageToken);
  return params;
}

// Repli 1 : route Next.js même origine (/api/yt/list, déployée sur Vercel) —
// contourne l'egress Worker bloqué par l'edge Google. Repli 2 : proxy Worker
// (au cas où Vercel serait indisponible). Sans les deux, l'état vide s'affiche.
async function proxySearch(channelId: string, opts: { q?: string; pageToken?: string; maxResults: number }): Promise<YoutubeListResponse> {
  const params = proxyListParams(channelId, opts);
  try {
    const response = await fetch(`/api/yt/list?${params.toString()}`, { headers: { accept: 'application/json' } });
    if (response.ok) return (await response.json()) as YoutubeListResponse;
  } catch { /* on tente le Worker */ }
  const { apiGet } = await import('../../shared/api/client');
  return apiGet<YoutubeListResponse>('/vod/youtube', Object.fromEntries(params) as Record<string, string>);
}

/** Liste paginée : direct navigateur d'abord, proxy serveur en repli. */
export async function fetchYoutubeList(channelId: string, opts: { q?: string; pageToken?: string; maxResults: number }): Promise<YoutubeListResponse> {
  const cacheKey = `list:${channelId}:${opts.q ?? ''}:${opts.pageToken ?? ''}:${opts.maxResults}`;
  const cached = cacheGet(cacheKey);
  if (cached && 'items' in cached) return cached as YoutubeListResponse;
  try {
    const fresh = await directSearch(channelId, opts);
    cacheSet(cacheKey, fresh, LIST_TTL_MS);
    return fresh;
  } catch {
    return proxySearch(channelId, opts);
  }
}

/** Fiche vidéo : direct navigateur d'abord, proxy serveur en repli. */
export async function fetchYoutubeVideo(videoId: string): Promise<YoutubeVideo> {
  const cacheKey = `video:${videoId}`;
  const cached = cacheGet(cacheKey);
  if (cached && !('items' in cached)) return cached as YoutubeVideo;
  try {
    const fresh = await directVideo(videoId);
    cacheSet(cacheKey, fresh, VIDEO_TTL_MS);
    return fresh;
  } catch {
    try {
      const response = await fetch(`/api/yt/video?id=${encodeURIComponent(videoId)}`, { headers: { accept: 'application/json' } });
      if (response.ok) return (await response.json()) as YoutubeVideo;
    } catch { /* on tente le Worker */ }
    const { apiGet } = await import('../../shared/api/client');
    return apiGet<YoutubeVideo>('/vod/youtube/video', { id: videoId });
  }
}
