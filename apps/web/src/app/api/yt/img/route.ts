import { NextRequest, NextResponse } from 'next/server';

// Proxy de miniatures i.ytimg.com (voir youtubeThumb.ts pour le motif FAI).
// Le body est streamé tel quel ; la qualité demandée retombe sur hq si
// maxres/sd n'existe pas pour la vidéo (404 YouTube fréquent sur maxres).
import { parseThumbQuality, thumbUpstreamUrl } from '@/features/vod/youtubeThumb';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const FALLBACK_QUALITY = 'hq';
const CACHE_S = 7 * 24 * 3600;

export async function GET(request: NextRequest): Promise<NextResponse | Response> {
  const params = new URL(request.url).searchParams;
  const videoId = (params.get('id') ?? '').trim();
  if (!VIDEO_ID_RE.test(videoId)) {
    return NextResponse.json({ message: 'Identifiant vidéo invalide' }, { status: 400 });
  }
  const quality = parseThumbQuality(params.get('q'));

  const fetchThumb = (q: string) =>
    fetch(thumbUpstreamUrl(videoId, q as Parameters<typeof thumbUpstreamUrl>[1]), {
      headers: { 'user-agent': 'Mozilla/5.0', accept: 'image/*' },
      signal: AbortSignal.timeout(10_000),
    });

  let upstream = await fetchThumb(quality);
  if (!upstream.ok && quality !== FALLBACK_QUALITY) upstream = await fetchThumb(FALLBACK_QUALITY);
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ message: 'Miniature introuvable' }, { status: 404 });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'image/jpeg',
      'cache-control': `public, max-age=${CACHE_S}, stale-while-revalidate=86400`,
    },
  });
}
