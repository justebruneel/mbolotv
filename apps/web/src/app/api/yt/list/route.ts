import { NextRequest, NextResponse } from 'next/server';
import { proxiedThumbUrl } from '@/features/vod/youtubeThumb';

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

function allowlist(): string[] {
  return String(process.env.YOUTUBE_CHANNEL_ALLOWLIST ?? AFOREVO_CHANNEL_ID)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
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
  if (!allowlist().includes(channelId)) {
    return NextResponse.json({ message: 'Chaîne non autorisée' }, { status: 403 });
  }
  const key = (process.env.YOUTUBE_API_KEY ?? '').trim();
  if (!key) return NextResponse.json({ message: 'Clé YouTube non configurée' }, { status: 503 });
  const maxResults = Math.min(Math.max(Number(params.get('limit')) || 25, 1), 50);
  const pageToken = params.get('pageToken');
  const q = (params.get('q') ?? '').trim().slice(0, 80);

  const upstream = new URL(`${YT_API}/search`);
  upstream.searchParams.set('part', 'snippet');
  upstream.searchParams.set('type', 'video');
  upstream.searchParams.set('order', 'date');
  upstream.searchParams.set('channelId', channelId);
  upstream.searchParams.set('maxResults', String(maxResults));
  if (q) upstream.searchParams.set('q', q);
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
    console.log(`[yt/list] ${response.status} url=${upstream.toString()} server=${response.headers.get('server') ?? '?'} cf-ray=${response.headers.get('cf-ray') ?? '-'} alt-svc=${(response.headers.get('alt-svc') ?? '-').slice(0, 40)}`);
    return NextResponse.json({ message: `YouTube a répondu ${response.status}` }, { status: 502 });
  }
  let payload: {
    items?: Array<{ id?: { videoId?: unknown }; snippet?: { title?: unknown; description?: unknown; publishedAt?: unknown; thumbnails?: unknown } }>;
    nextPageToken?: unknown;
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return NextResponse.json({ message: 'Réponse YouTube invalide' }, { status: 502 });
  }
  const items = (Array.isArray(payload?.items) ? payload.items : [])
    .map((entry) => {
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
    .filter((entry): entry is { id: string; title: string; description: string | null; posterUrl: string | null; publishedAt: string | null; duration: null } => entry !== null);
  return NextResponse.json({
    items,
    nextPageToken: typeof payload?.nextPageToken === 'string' ? payload.nextPageToken : null,
  });
}
