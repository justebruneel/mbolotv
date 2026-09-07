// Registre des scrapers de fiches (French Stream, Flemmix/Wiflix à venir).
// Ajouter un site = créer scrapers/<site>.js ({ SITE, matchUrl, scrapeFiche })
// et l'enregistrer ici — la route et le contrat ne changent pas.
//
// Contrat d'adapter :
//   matchUrl(url: string) -> { … } | null   (reconnaissance + params)
//   scrapeFiche(env, url: string) ->
//     { site, title, year, posterUrl, backdropUrl, trailerYoutubeId,
//       players: [{ host, versions, embedUrl, wrapped, finalUrl }] }
import * as frenchstream from './frenchstream.js';

const REGISTRY = [frenchstream];

// Exporté pour external.resyncExternalMeta (backfill des détails) : retrouver
// l'adapter d'une ficheUrl stockée en base.
export { REGISTRY };

export const SUPPORTED_FICHE_SITES = REGISTRY.map((adapter) => adapter.SITE);

function jsonError(message, status, cors = {}) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors },
  });
}

/**
 * Aperçu d'import (niveau données, partagé par la route publique et la
 * publication owner) : métas + lecteurs, SANS écrire en base.
 */
export async function previewFiche(env, url) {
  const value = String(url ?? '').trim();
  const adapter = REGISTRY.find((entry) => entry.matchUrl(value) !== null);
  if (!adapter) {
    const error = new Error(`Site non pris en charge (soutenus : ${SUPPORTED_FICHE_SITES.join(', ')})`);
    error.status = 400;
    throw error;
  }
  return adapter.scrapeFiche(env, value);
}

/**
 * GET /api/x/fiche?url=<fiche>
 * Mise en cache edge 5 min : la publication relit ce cache au lieu de
 * re-scraper (fiche + ~9 suivis de wrappers = ~20 sous-requêtes économisées
 * sur le budget CF de l'invocation publish).
 */
export async function serveFichePreview(env, url, cors = {}) {
  try {
    const preview = await previewFiche(env, url);
    const response = new Response(JSON.stringify(preview), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `no-store`, ...cors },
    });
    const cache = globalThis.caches?.default;
    if (cache) {
      // Entrée cache SÉPARÉE avec TTL 5 min (la réponse client reste
      // no-store : un no-store mis en cache ne serait jamais relu).
      const cached = new Response(JSON.stringify(preview), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
      });
      await cache.put(new Request(ficheCacheKey(url)), cached).catch(() => undefined);
    }
    return response;
  } catch (error) {
    const status = error instanceof Error && typeof error.status === 'number' ? error.status : 502;
    return jsonError(error instanceof Error ? error.message : 'Fiche illisible', status, cors);
  }
}

function ficheCacheKey(url) {
  return `https://x.internal/fiche?url=${encodeURIComponent(String(url ?? '').trim())}`;
}

/** Relecture du cache aperçu (publication) : null si absent/expiré. */
export async function readCachedPreview(env, url) {
  void env;
  const cache = globalThis.caches?.default;
  if (!cache) return null;
  try {
    const hit = await cache.match(new Request(ficheCacheKey(url)));
    if (!hit) return null;
    const preview = await hit.json();
    if (!preview || !Array.isArray(preview.players)) return null;
    return preview;
  } catch {
    return null;
  }
}

export const _internal = { REGISTRY };
