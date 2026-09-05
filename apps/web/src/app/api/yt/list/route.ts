import { NextRequest, NextResponse } from 'next/server';
import { proxiedThumbUrl } from '@/features/vod/youtubeThumb';
import { stripTrailingVideoId } from '@/features/vod/youtubeDescription';

// Proxy YouTube Data v3 côté Vercel (onglet Nollywood) : même contrat que la
// route Worker /api/vod/youtube (mise en place car l'egress du Worker vers
// googleapis répond 404 vide). Clé via YOUTUBE_API_KEY (variables Vercel,
// jamais exposée). search.list scopé chaîne (type=video, order=date),
// cache Next 1 h (quota : 100 unités/appel partagé).
// Chemin REST = /search (et non /search.list qui est la notation de la doc
// et répond 404).
const YT_API = 'https://www.googleapis.com/youtube/v3';
const AFOREVO_CHANNEL_ID = 'UCyd79F-lNLCbGPQrf_L7KiA';
const REVALIDATE_S = 3600;

// Allowlist : la table VodYoutubeSource (console VOD) exposée par le endpoint
// public /api/vod/youtube/channels du backend est la source de vérité ; repli
// sur l'env (comportement historique) si le backend ne répond pas. Jamais une
// liste vide par erreur de réseau. Mémo module 60 s (indépendant du cache
// fetch des listes, qui reste à 1 h).
const ALLOWLIST_TTL_MS = 60_000;
let allowlistMemo: { ids: string[]; at: number } = { ids: [], at: 0 };

function envAllowlist(): string[] {
  return String(process.env.YOUTUBE_CHANNEL_ALLOWLIST ?? AFOREVO_CHANNEL_ID)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function allowlist(): Promise<string[]> {
  const now = Date.now();
  if (allowlistMemo.ids.length > 0 && now - allowlistMemo.at < ALLOWLIST_TTL_MS) return allowlistMemo.ids;
  const apiBase = (process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? '').trim().replace(/\/+$/, '');
  if (apiBase) {
    try {
      const response = await fetch(`${apiBase}/api/vod/youtube/channels`, { signal: AbortSignal.timeout(6_000), cache: 'no-store' });
      if (response.ok) {
        const payload = (await response.json()) as { channelIds?: unknown };
        const ids = Array.isArray(payload?.channelIds) ? payload.channelIds.filter((value): value is string => typeof value === 'string') : [];
        if (ids.length > 0) {
          allowlistMemo = { ids, at: now };
          return ids;
        }
      }
    } catch { /* backend injoignable : repli env */ }
  }
  return envAllowlist();
}

function pickThumbnail(thumbnails: unknown): string | null {
  if (!thumbnails || typeof thumbnails !== 'object') return null;
  const record = thumbnails as Record<string, { url?: unknown }>;
  for (const quality of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const url = record[quality]?.url;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return proxiedThumbUrl(url);
  }
  return null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const channelId = params.get('channel') ?? '';
  if (!(await allowlist()).includes(channelId)) {
    return NextResponse.json({ message: 'Chaîne non autorisée' }, { status: 403 });
  }
  const key = (process.env.YOUTUBE_API_KEY ?? '').trim();
  if (!key) return NextResponse.json({ message: 'Clé YouTube non configurée' }, { status: 503 });
  const maxResults = Math.min(Math.max(Number(params.get('limit')) || 25, 1), 50);
  const pageToken = params.get('pageToken');
  const q = (params.get('q') ?? '').trim().slice(0, 80);

  // Sans q : playlist uploads (catalogue complet ~2500 items, 1 unité de
  // quota). Avec q : search.list (moteur, 100 unités). UC… -> UU… pour la
  // playlist « uploads » de la chaîne.
  const upstream = new URL(`${YT_API}/${q ? 'search' : 'playlistItems'}`);
  if (q) {
    upstream.searchParams.set('type', 'video');
    upstream.searchParams.set('order', 'date');
    upstream.searchParams.set('channelId', channelId);
    upstream.searchParams.set('q', q);
  } else {
    upstream.searchParams.set('playlistId', channelId.startsWith('UC') ? `UU${channelId.slice(2)}` : channelId);
  }
  upstream.searchParams.set('part', 'snippet');
  upstream.searchParams.set('maxResults', String(maxResults));
  if (pageToken) upstream.searchParams.set('pageToken', pageToken);
  upstream.searchParams.set('key', key);

  let response: Response;
  try {
    response = await fetch(upstream.toString(), {
      headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
      next: { revalidate: REVALIDATE_S },
    });
  } catch {
    return NextResponse.json({ message: 'YouTube injoignable' }, { status: 502 });
  }
  if (!response.ok) {
    let reason = '';
    try {
      const body = (await response.json()) as { error?: { errors?: Array<{ reason?: string }>; message?: string } };
      reason = body?.error?.errors?.[0]?.reason ?? '';
      if (response.status === 403 && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded')) {
        return NextResponse.json({ message: 'Quota YouTube épuisé, réessayez plus tard' }, { status: 429 });
      }
    } catch { /* corps illisible */ }
    return NextResponse.json({ message: `YouTube a répondu ${response.status}` }, { status: 502 });
  }
  let payload: {
    items?: Array<{ id?: { videoId?: unknown }; snippet?: { title?: unknown; description?: unknown; publishedAt?: unknown; thumbnails?: unknown; resourceId?: { videoId?: unknown } } }>;
    nextPageToken?: unknown;
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return NextResponse.json({ message: 'Réponse YouTube invalide' }, { status: 502 });
  }
  const items = (Array.isArray(payload?.items) ? payload.items : [])
    .map((entry) => {
      const videoId = entry?.id?.videoId ?? entry?.snippet?.resourceId?.videoId;
      if (typeof videoId !== 'string' || !videoId) return null;
      return {
        id: videoId,
        title: typeof entry.snippet?.title === 'string' ? entry.snippet.title : 'Sans titre',
        description: stripTrailingVideoId(
          typeof entry.snippet?.description === 'string' ? entry.snippet.description : null,
          videoId,
        ),
        posterUrl: pickThumbnail(entry.snippet?.thumbnails),
        publishedAt: typeof entry.snippet?.publishedAt === 'string' ? entry.snippet.publishedAt : null,
        duration: null,
      };
    })
    .filter((entry): entry is { id: string; title: string; description: string | null; posterUrl: string | null; publishedAt: string | null; duration: null } => entry !== null);
  return NextResponse.json({
    items,
    nextPageToken: typeof payload?.nextPageToken === 'string' ? payload.nextPageToken : null,
  });
}
