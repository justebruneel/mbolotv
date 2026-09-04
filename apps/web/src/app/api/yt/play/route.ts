import { NextRequest, NextResponse } from 'next/server';

// Flux direct pour le lecteur maison (fiche Nollywood /vod/yt/<id>) — même
// contrat que le Worker /api/yt/play. InnerTube : chaîne de clients
// ANDROID -> IOS (clés publiques intégrées à l'app YouTube, cf. yt-dlp) qui
// renvoient des formats progressifs MP4 non chiffrés. Cache 4 h (les URL de
// flux expirent ~6 h).
const INNERTUBE_API = 'https://www.youtube.com/youtubei/v1/player';

interface InnertubeClient {
  key: string;
  context: Record<string, unknown>;
  headers: Record<string, string>;
}

const CLIENTS: InnertubeClient[] = [
  {
    key: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
    context: {
      client: {
        clientName: 'ANDROID',
        clientVersion: '19.09.37',
        androidSdkVersion: 30,
        osName: 'Android',
        osVersion: '11',
        hl: 'fr',
        gl: 'GA',
      },
    },
    headers: {
      'user-agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
      'x-youtube-client-name': '3',
      'x-youtube-client-version': '19.09.37',
    },
  },
  {
    key: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
    context: {
      client: {
        clientName: 'IOS',
        clientVersion: '19.29.1',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        osName: 'iPhone',
        osVersion: '17.5.1.21F90',
        hl: 'fr',
        gl: 'GA',
      },
    },
    headers: {
      'user-agent': 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)',
      'x-youtube-client-name': '5',
      'x-youtube-client-version': '19.29.1',
    },
  },
];

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
  for (const client of CLIENTS) {
    let response: Response;
    try {
      response = await fetch(`${INNERTUBE_API}?key=${client.key}&prettyPrint=false`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-language': 'fr-FR,fr;q=0.9', ...client.headers },
        body: JSON.stringify({ context: client.context, videoId, contentCheckOk: true, racyCheckOk: true }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      continue;
    }
    if (!response.ok) continue;
    let playerResponse: {
      playabilityStatus?: { status?: unknown; reason?: unknown };
      streamingData?: { formats?: Array<{ itag?: unknown; url?: unknown; mimeType?: unknown }>; adaptiveFormats?: Array<{ itag?: unknown; url?: unknown; mimeType?: unknown }>; expiresInSeconds?: unknown };
    };
    try {
      playerResponse = (await response.json()) as typeof playerResponse;
    } catch {
      continue;
    }
    const urls = pickPlayableFormats(playerResponse);
    if (playerResponse?.playabilityStatus?.status === 'OK' && urls.length > 0) {
      return NextResponse.json({
        id: videoId,
        urls,
        expiresInSeconds: Number(playerResponse?.streamingData?.expiresInSeconds) || 21540,
      }, { headers: { 'cache-control': `public, max-age=${REVALIDATE_S}` } });
    }
  }
  return NextResponse.json({ message: 'Flux indisponible pour cette vidéo' }, { status: 451 });
}
