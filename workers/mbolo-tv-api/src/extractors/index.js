// Registre des extracteurs tiers + route de lecture générique.
// Ajouter un host = créer extractors/<host>.js (parse/resolve) et
// l'enregistrer ici — la route, le cache, la signature et les erreurs
// ne changent pas. Doodstream/Voe/Uptostream suivront ce contrat.
//
// Contrat d'adapter :
//   parse(input: string) -> { id: string }            (lève INVALID)
//   mirrorsFromEnv?(env) -> string[]
//   resolve(env, ref: string | { id }) ->
//     { urls: string[], referer: string, title: string | null }
import { playResponse } from '../play.js';
import { extractorError, ExtractorErrorCode } from './errors.js';
import * as mixdrop from './mixdrop.js';
import * as dood from './dood.js';

const REGISTRY = { [mixdrop.HOST]: mixdrop, [dood.HOST]: dood };

export const SUPPORTED_HOSTS = Object.keys(REGISTRY);

// Les liens signés expirent vite côté hosts : cache edge 1 h max
// (YouTube = 4 h car expiry ~6 h ; ici expiry souvent < 24 h et tokens
// parfois à usage unique — le lecteur re-résout au besoin via retry).
const PLAY_CACHE_TTL_S = 3_600;

function jsonError(message, status, cors = {}) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors },
  });
}

/**
 * GET /api/x/play?host=mixdrop&id=<fileId|embedUrl>
 * Même contrat que /api/yt/play : { id, urls: [proxySigné…], expiresInSeconds }.
 * urls = URL du proxy vidéo signé (avec Referer injecté) — le navigateur ne
 * touche jamais le CDN tiers directement.
 */
export async function serveExternalPlay(env, host, ref, cors = {}) {
  const name = String(host ?? '').trim().toLowerCase();
  const adapter = REGISTRY[name];
  if (!adapter) {
    return jsonError(
      `Hôte non pris en charge (soutenus : ${SUPPORTED_HOSTS.join(', ')})`,
      400,
      cors,
    );
  }
  let resolved;
  try {
    resolved = await adapter.resolve(env, String(ref ?? ''));
  } catch (error) {
    const status = error instanceof Error && typeof error.status === 'number' ? error.status : 502;
    return jsonError(error instanceof Error ? error.message : 'Extraction indisponible', status, cors);
  }
  if (!resolved?.urls?.length || !resolved?.referer) {
    return jsonError('Extraction sans flux exploitable', 502, cors);
  }
  const cache = globalThis.caches?.default;
  const cacheKey = `https://x.internal/play?host=${name}&id=${encodeURIComponent(canonicalId(ref))}`;
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }
  // VOD : sortie directe Cloudflare (fichiers lourds, pas de relais
  // résidentiel), comme /api/vod/:id/play.
  const out = [];
  try {
    for (const providerUrl of resolved.urls.slice(0, 3)) {
      const play = await playResponse(env, providerUrl, null, { direct: true, referer: resolved.referer });
      out.push(play.url);
    }
  } catch {
    return jsonError('Proxy vidéo non configuré', 502, cors);
  }
  const payload = {
    id: canonicalId(ref),
    host: name,
    ...(resolved.title ? { title: resolved.title } : {}),
    urls: out,
    expiresInSeconds: PLAY_CACHE_TTL_S,
  };
  const response = new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${PLAY_CACHE_TTL_S}`, ...cors },
  });
  if (cache) await cache.put(new Request(cacheKey), response.clone()).catch(() => undefined);
  return response;
}

function canonicalId(ref) {
  const value = String(ref ?? '').trim();
  const embedded = /\/(?:e|f)\/([A-Za-z0-9_-]{4,64})/.exec(value);
  return embedded?.[1] ?? value;
}

export const _internal = { REGISTRY };
export { extractorError, ExtractorErrorCode };
