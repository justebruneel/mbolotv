import { resolveRelay } from './relay.js';

// Proxy YouTube Data v3 (onglet Nollywood) : la clé API reste côté serveur
// (env.YOUTUBE_API_KEY, wrangler secret — jamais exposée au front).
// Pas de SSRF exploitable : la seule origine contactée est googleapis.com
// (ou le relais configuré), les paramètres sont validés (allowlist de
// chaînes, regex d'ID vidéo).
//
// Stratégie quota : search.list scopé chaîne (type=video, order=date) =
// 100 unités/appel, amorties par le cache edge partagé (1 h) : ~10-20 pages
// uniques/jour. JAMAIS de search global non scopé. Fiche : videos.list.
// (playlistItems/channels répondent 404 vide depuis nos egress.)
// Réseau : repli via le relais résidentiel si le direct échoue (même motif
// que xtream.js — les egress datacenter sont parfois refusés).
// Cache edge : 1 h sur les listes, 24 h sur les fiches.
// Allowlist : seules les chaînes configurées (YOUTUBE_CHANNEL_ALLOWLIST,
// défaut Aforevo Galerie) sont interrogeables — pas de scraping arbitraire.
const YT_API = 'https://www.googleapis.com/youtube/v3';
const AFOREVO_CHANNEL_ID = 'UCyd79F-lNLCbGPQrf_L7KiA';
const LIST_CACHE_TTL_S = 3600;
const VIDEO_CACHE_TTL_S = 24 * 3600;
const YT_TIMEOUT_MS = 15_000;

function jsonError(message, status) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function channelAllowlist(env) {
  return String(env.YOUTUBE_CHANNEL_ALLOWLIST ?? AFOREVO_CHANNEL_ID)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function pickThumbnail(thumbnails) {
  if (!thumbnails || typeof thumbnails !== 'object') return null;
  for (const quality of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const url = thumbnails[quality]?.url;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
  }
  return null;
}

function parseDuration(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(value ?? ''));
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

async function ytFetch(env, action, params) {
  const key = String(env.YOUTUBE_API_KEY ?? '').trim();
  if (!key) throw Object.assign(new Error('Clé YouTube non configurée'), { status: 503 });
  const url = new URL(`${YT_API}/${action}`);
  for (const [name, value] of Object.entries({ ...params, key })) {
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }
  // Direct d'abord, relais résidentiel en repli (l'edge Google refuse parfois
  // les egress datacenter avec un 404 vide — même motif que xtream.js).
  const relayed = resolveRelay(env, url.toString());
  const targets = [{ url: url.toString(), headers: {}, viaRelay: false }];
  if (relayed.url !== url.toString()) targets.push({ url: relayed.url, headers: relayed.headers, viaRelay: true });
  let lastError = null;
  for (const target of targets) {
    let response;
    try {
      const startedAt = Date.now();
      response = await fetch(target.url, {
        headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json', ...target.headers },
        signal: AbortSignal.timeout(YT_TIMEOUT_MS),
      });
      console.log(`[youtube] ${action} -> ${response.status} (${Math.round((Date.now() - startedAt) / 1000)}s, ${target.viaRelay ? 'relais' : 'direct'})`);
    } catch {
      lastError = Object.assign(new Error('YouTube injoignable'), { status: 502 });
      continue;
    }
    if (!response.ok) {
      let reason = '';
      let detail = '';
      try {
        const text = await response.text();
        detail = text.slice(0, 200);
        try {
          const body = JSON.parse(text);
          reason = body?.error?.errors?.[0]?.reason ?? '';
          detail = body?.error?.message ?? detail;
        } catch { /* pas du JSON : texte brut conservé */ }
      } catch { /* corps illisible : statut brut conservé */ }
      console.log(`[youtube] ${action} debug: server=${response.headers.get('server') ?? '?'} ct=${response.headers.get('content-type') ?? '?'} cf-ray=${response.headers.get('cf-ray') ?? '-'}`);
      if (detail) console.log(`[youtube] ${action} erreur: ${detail.slice(0, 160)}`);
      if (response.status === 403 && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded')) {
        throw Object.assign(new Error('Quota YouTube épuisé, réessayez plus tard'), { status: 429 });
      }
      lastError = Object.assign(new Error(`YouTube a répondu ${response.status}`), { status: 502 });
      continue;
    }
    try {
      return await response.json();
    } catch {
      throw Object.assign(new Error('Réponse YouTube invalide'), { status: 502 });
    }
  }
  throw lastError ?? Object.assign(new Error('YouTube indisponible'), { status: 502 });
}

function normalizeSearchItem(item) {
  const videoId = item?.id?.videoId;
  if (typeof videoId !== 'string' || !videoId) return null;
  return {
    id: videoId,
    title: typeof item.snippet?.title === 'string' ? item.snippet.title : 'Sans titre',
    description: typeof item.snippet?.description === 'string' ? item.snippet.description : null,
    posterUrl: pickThumbnail(item.snippet?.thumbnails),
    publishedAt: typeof item.snippet?.publishedAt === 'string' ? item.snippet.publishedAt : null,
    duration: null,
  };
}

export async function serveYoutubeList(env, channelId, pageToken, limit, q) {
  if (!channelAllowlist(env).includes(channelId)) return jsonError('Chaîne non autorisée', 403);
  if (!String(env.YOUTUBE_API_KEY ?? '').trim()) return jsonError('Clé YouTube non configurée', 503);
  const maxResults = Math.min(Math.max(Number(limit) || 25, 1), 50);
  const query = typeof q === 'string' ? q.trim().slice(0, 80) : '';
  const cache = globalThis.caches?.default;
  const cacheKey = `https://yt.internal/search?channel=${encodeURIComponent(channelId)}&q=${encodeURIComponent(query)}&page=${encodeURIComponent(pageToken ?? '')}&limit=${maxResults}`;
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }
  let payload;
  try {
    payload = await ytFetch(env, 'search.list', {
      part: 'snippet',
      type: 'video',
      order: 'date',
      channelId,
      maxResults,
      ...(query ? { q: query } : {}),
      ...(pageToken ? { pageToken } : {}),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'YouTube indisponible', error instanceof Error && typeof error.status === 'number' ? error.status : 502);
  }
  const items = (Array.isArray(payload?.items) ? payload.items : []).map(normalizeSearchItem).filter(Boolean);
  const response = new Response(JSON.stringify({ items, nextPageToken: typeof payload?.nextPageToken === 'string' ? payload.nextPageToken : null }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${LIST_CACHE_TTL_S}` },
  });
  if (cache) await cache.put(new Request(cacheKey), response.clone()).catch(() => undefined);
  return response;
}

export async function serveYoutubeVideo(env, videoId) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return jsonError('Identifiant vidéo invalide', 400);
  if (!String(env.YOUTUBE_API_KEY ?? '').trim()) return jsonError('Clé YouTube non configurée', 503);
  const cache = globalThis.caches?.default;
  const cacheKey = `https://yt.internal/video?id=${encodeURIComponent(videoId)}`;
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }
  let payload;
  try {
    payload = await ytFetch(env, 'videos.list', { part: 'snippet,contentDetails', id: videoId });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'YouTube indisponible', error instanceof Error && typeof error.status === 'number' ? error.status : 502);
  }
  const item = Array.isArray(payload?.items) ? payload.items[0] : null;
  if (!item) return jsonError('Vidéo introuvable', 404);
  const normalized = {
    id: videoId,
    title: typeof item.snippet?.title === 'string' ? item.snippet.title : 'Sans titre',
    description: typeof item.snippet?.description === 'string' ? item.snippet.description : null,
    posterUrl: pickThumbnail(item.snippet?.thumbnails),
    publishedAt: typeof item.snippet?.publishedAt === 'string' ? item.snippet.publishedAt : null,
    duration: parseDuration(item.contentDetails?.duration),
  };
  const response = new Response(JSON.stringify(normalized), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${VIDEO_CACHE_TTL_S}` },
  });
  if (cache) await cache.put(new Request(cacheKey), response.clone()).catch(() => undefined);
  return response;
}

export const _internal = { YT_API, AFOREVO_CHANNEL_ID, LIST_CACHE_TTL_S, pickThumbnail, parseDuration };
