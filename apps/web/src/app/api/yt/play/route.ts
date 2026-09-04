import { NextRequest, NextResponse } from 'next/server';

// Flux direct pour le lecteur maison (fiche Nollywood /vod/yt/<id>) — même
// contrat que le Worker /api/yt/play. InnerTube client ANDROID : renvoie des
// formats progressifs MP4 (itag 22 720p / 18 360p) généralement non chiffrés.
// Cache 4 h (les URL de flux expirent ~6 h).
const INNERTUBE_API = 'https://www.youtube.com/youtubei/v1/player';
const ANDROID_CONTEXT = {
  client: { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30, hl: 'fr', gl: 'GA' },
};
const UA_ANDROID = 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip';
const REVALIDATE_S = 4 * 3600;

function pickPlayableFormats(playerResponse: {
  streamingData?: { formats?: Array<{ itag?: unknown; url?: unknown; mimeType?: unknown }>; adaptiveFormats?: Array<{ itag?: unknown; url?: unknown; mimeType?: unknown }> };
}): string[] {
  const streaming = playerResponse?.streamingData ?? {};
  const candidates = [...(streaming.formats ?? []), ...(streaming.adaptiveFormats ?? [])];
  const usable = candidates.filter((f) => typeof f?.url === 'string' && (f.url as string).length > 0 && String(f?.mimeType ?? '').startsWith('video/mp4'));
  const byItag = (itag: number) => usable.find((f) => f.itag === itag);
  const urls: string[] = [];
  for (const candidate of [byItag(22), byItag(18), ...usable]) {
    const url = candidate?.url;
    if (typeof url === 'string' && !urls.includes(url)) urls.push(url);
    if (urls.length >= 3) break;
  }
  return urls;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const videoId = (new URL(request.url).searchParams.get('id') ?? '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return NextResponse.json({ message: 'Identifiant vidéo invalide' }, { status: 400 });
  }
  let response: Response;
  try {
    response = await fetch(`${INNERTUBE_API}?prettyPrint=false`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': UA_ANDROID,
        'x-youtube-client-name': '3',
        'x-youtube-client-version': '19.09.37',
        'accept-language': 'fr-FR,fr;q=0.9',
      },
      body: JSON.stringify({ context: ANDROID_CONTEXT, videoId, contentCheckOk: true, racyCheckOk: true }),
      signal: AbortSignal.timeout(15_000),
      next: { revalidate: REVALIDATE_S },
    });
  } catch {
    return NextResponse.json({ message: 'YouTube injoignable' }, { status: 502 });
  }
  if (!response.ok) {
    return NextResponse.json({ message: `YouTube a répondu ${response.status}` }, { status: 502 });
  }
  let playerResponse: {
    playabilityStatus?: { status?: unknown; reason?: unknown };
    streamingData?: { formats?: Array<{ itag?: unknown; url?: unknown; mimeType?: unknown }>; adaptiveFormats?: Array<{ itag?: unknown; url?: unknown; mimeType?: unknown }>; expiresInSeconds?: unknown };
  };
  try {
    playerResponse = (await response.json()) as typeof playerResponse;
  } catch {
    return NextResponse.json({ message: 'Réponse YouTube invalide' }, { status: 502 });
  }
  const urls = pickPlayableFormats(playerResponse);
  if (playerResponse?.playabilityStatus?.status !== 'OK' || urls.length === 0) {
    const reason = typeof playerResponse?.playabilityStatus?.reason === 'string' ? playerResponse.playabilityStatus.reason : 'Flux indisponible pour cette vidéo';
    return NextResponse.json({ message: reason }, { status: 451 });
  }
  return NextResponse.json({
    id: videoId,
    urls,
    expiresInSeconds: Number(playerResponse?.streamingData?.expiresInSeconds) || 21540,
  });
}
