import { NextRequest, NextResponse } from 'next/server';
import { proxiedThumbUrl } from '@/features/vod/youtubeThumb';
import { stripTrailingVideoId } from '@/features/vod/youtubeDescription';

// Fiche vidéo YouTube Data v3 côté Vercel (même motif que /api/yt/list) :
// l'egress Worker vers googleapis répond 404 vide. Clé via YOUTUBE_API_KEY
// (variables Vercel, jamais exposée). videos.list = 1 unité/appel.
// Cache Next 24 h (contrat identique à la route Worker /api/vod/youtube/video).
// Chemin REST = /videos (et non /videos.list qui est la notation de la doc
// et répond 404).
const YT_API = 'https://www.googleapis.com/youtube/v3';
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const REVALIDATE_S = 86400;

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
  const videoId = (new URL(request.url).searchParams.get('id') ?? '').trim();
  if (!VIDEO_ID_RE.test(videoId)) {
    return NextResponse.json({ message: 'Identifiant vidéo invalide' }, { status: 400 });
  }
  const key = (process.env.YOUTUBE_API_KEY ?? '').trim();
  if (!key) return NextResponse.json({ message: 'Clé YouTube non configurée' }, { status: 503 });

  const upstream = new URL(`${YT_API}/videos`);
  upstream.searchParams.set('part', 'snippet,contentDetails');
  upstream.searchParams.set('id', videoId);
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
    items?: Array<{ snippet?: { title?: unknown; description?: unknown; publishedAt?: unknown; thumbnails?: unknown }; contentDetails?: { duration?: unknown } }>;
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return NextResponse.json({ message: 'Réponse YouTube invalide' }, { status: 502 });
  }
  const item = Array.isArray(payload?.items) ? payload.items[0] : null;
  if (!item) return NextResponse.json({ message: 'Vidéo introuvable' }, { status: 404 });
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(item.contentDetails?.duration ?? ''));
  return NextResponse.json({
    id: videoId,
    title: typeof item.snippet?.title === 'string' ? item.snippet.title : 'Sans titre',
    description: stripTrailingVideoId(
      typeof item.snippet?.description === 'string' ? item.snippet.description : null,
      videoId,
    ),
    posterUrl: pickThumbnail(item.snippet?.thumbnails),
    publishedAt: typeof item.snippet?.publishedAt === 'string' ? item.snippet.publishedAt : null,
    duration: match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : null,
  });
}
