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

export const SUPPORTED_FICHE_SITES = REGISTRY.map((adapter) => adapter.SITE);

function jsonError(message, status, cors = {}) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors },
  });
}

/**
 * GET /api/x/fiche?url=<fiche>
 * Aperçu d'import : métas + lecteurs (wrappers suivis 1 hop), SANS écrire en
 * base. Pas de cache : les fiches changent (ajout/retrait de lecteurs).
 */
export async function serveFichePreview(env, url, cors = {}) {
  const value = String(url ?? '').trim();
  const adapter = REGISTRY.find((entry) => entry.matchUrl(value) !== null);
  if (!adapter) {
    return jsonError(
      `Site non pris en charge (soutenus : ${SUPPORTED_FICHE_SITES.join(', ')})`,
      400,
      cors,
    );
  }
  try {
    const preview = await adapter.scrapeFiche(env, value);
    return new Response(JSON.stringify(preview), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors },
    });
  } catch (error) {
    const status = error instanceof Error && typeof error.status === 'number' ? error.status : 502;
    return jsonError(error instanceof Error ? error.message : 'Fiche illisible', status, cors);
  }
}

export const _internal = { REGISTRY };
