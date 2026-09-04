import { resolveRelay } from './relay.js';
import { resolveGoogleapisIp } from './youtube.js';

// Extraction de flux pour le lecteur maison (Player @mbolo/ui) : l'iframe
// officielle YouTube est remplacée par la lecture directe « Netflix-like ».
// Méthode : InnerTube API (client ANDROID) — POST www.youtube.com/youtubei/v1/
// player avec un contexte client Android ; Google renvoie alors des formats
// progressifs (itag 18 mp4 360p / itag 22 720p quand dispo) généralement non
// chiffrés (signature vide). Paramètres validés (regex d'ID vidéo).
// Réseau : même cascade que ytFetch (direct, relais résidentiel en repli).
const INNERTUBE_API = 'https://www.youtube.com/youtubei/v1/player';
// Chaîne de clients InnerTube (clés publiques intégrées à l'app YouTube,
// cf. yt-dlp) : ANDROID d'abord, IOS en repli. Ils renvoient des formats
// progressifs MP4 généralement non chiffrés.
const INNERTUBE_CLIENTS = [
  {
    key: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
    context: { client: { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30, osName: 'Android', osVersion: '11', hl: 'fr', gl: 'GA' } },
    headers: {
      'user-agent': 'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip',
      'x-youtube-client-name': '3',
      'x-youtube-client-version': '21.26.364',
    },
  },
  {
    key: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
    context: { client: { clientName: 'IOS', clientVersion: '19.29.1', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '17.5.1.21F90', hl: 'fr', gl: 'GA' } },
    headers: {
      'user-agent': 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
      'x-youtube-client-name': '5',
      'x-youtube-client-version': '21.26.4',
    },
  },
];
const PLAY_TIMEOUT_MS = 15_000;
const PLAY_CACHE_TTL_S = 60 * 60 * 4; // Les URL de flux expirent ~6 h ; cache 4 h.

function jsonError(message, status, cors = {}) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors },
  });
}

// Formats progressifs non chiffrés, préférence décroissante (720p puis 360p) :
// le Player avance automatiquement à la source suivante en cas d'erreur.
function pickPlayableFormats(playerResponse) {
  const streaming = playerResponse?.streamingData ?? {};
  const candidates = [...(Array.isArray(streaming.formats) ? streaming.formats : []), ...(Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats : [])];
  const usable = candidates.filter((f) => typeof f?.url === 'string' && f.url.length > 0 && (f.mimeType ?? '').startsWith('video/mp4'));
  const byItag = (itag) => usable.find((f) => f.itag === itag);
  const urls = [];
  for (const candidate of [byItag(22), byItag(18), ...usable]) {
    if (candidate?.url && !urls.includes(candidate.url)) urls.push(candidate.url);
    if (urls.length >= 3) break;
  }
  return urls;
}

export async function serveYoutubePlay(env, videoId, cors = {}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return jsonError('Identifiant vidéo invalide', 400, cors);
  const cache = globalThis.caches?.default;
  const cacheKey = `https://yt.internal/play?id=${videoId}`;
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }
  const overrideIp = await resolveGoogleapisIp().catch(() => null);
  const relayed = resolveRelay(env, INNERTUBE_API);
  const targets = [];
  if (overrideIp) targets.push({ url: INNERTUBE_API, cf: { resolveOverride: overrideIp }, label: 'direct+doh' });
  targets.push({ url: INNERTUBE_API, label: 'direct' });
  if (relayed.url !== INNERTUBE_API) targets.push({ url: relayed.url, headers: relayed.headers, label: 'relais' });
  let playerResponse = null;
  let lastError = null;
  for (const client of INNERTUBE_CLIENTS) {
    const init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept-language': 'fr-FR,fr;q=0.9',
        ...client.headers,
      },
      body: JSON.stringify({ context: client.context, videoId, contentCheckOk: true, racyCheckOk: true }),
    };
    const base = `${INNERTUBE_API}?key=${client.key}&prettyPrint=false`;
    const targets = [];
    if (overrideIp) targets.push({ url: base, cf: { resolveOverride: overrideIp } });
    targets.push({ url: base });
    if (relayed.url !== INNERTUBE_API) targets.push({ url: relayed.url, headers: relayed.headers });
    for (const target of targets) {
      try {
        const response = await fetch(target.url, {
          ...init,
          headers: { ...init.headers, ...(target.headers ?? {}) },
          signal: AbortSignal.timeout(PLAY_TIMEOUT_MS),
          ...(target.cf ? { cf: target.cf } : {}),
        });
        if (!response.ok) {
          lastError = Object.assign(new Error(`YouTube a répondu ${response.status}`), { status: 502 });
          continue;
        }
        playerResponse = await response.json();
        if (playerResponse?.playabilityStatus?.status === 'OK' && pickPlayableFormats(playerResponse).length > 0) break;
        playerResponse = null;
      } catch {
        lastError = Object.assign(new Error('YouTube injoignable'), { status: 502 });
      }
    }
    if (playerResponse) break;
  }
  if (!playerResponse) {
    return jsonError(lastError?.message ?? 'YouTube indisponible', lastError?.status ?? 502, cors);
  }
  const status = playerResponse?.playabilityStatus?.status;
  const urls = pickPlayableFormats(playerResponse);
  if (status !== 'OK' || urls.length === 0) {
    const reason = playerResponse?.playabilityStatus?.reason ?? 'Flux indisponible pour cette vidéo';
    return jsonError(reason, 451, cors);
  }
  const payload = { id: videoId, urls, expiresInSeconds: Number(playerResponse?.streamingData?.expiresInSeconds) || 21540 };
  const out = new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${PLAY_CACHE_TTL_S}`, ...cors },
  });
  if (cache) await cache.put(new Request(cacheKey), out.clone()).catch(() => undefined);
  return out;
}
