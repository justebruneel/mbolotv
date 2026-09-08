// Titres externes publics (lecteurs tiers) : catalogue visible + détail.
// La lecture passe par /api/x/play (résolution au clic) — ici on ne sert que
// des métas et des références de lecture (finalUrl ?? embedUrl).
import { SUPPORTED_HOSTS, checkEmbedPage, checkSource } from './extractors/index.js';
import { REGISTRY as FICHE_ADAPTERS } from './scrapers/index.js';

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

// Un host sans extracteur ne PEUT pas être lu en direct (/api/x/play
// renvoie 400) : on l'expose toujours en iframe, même si la ligne en base
// dit « direct » (publiée avant le repli, ou colonne absente du SELECT).
// Source de vérité = REGISTRY des extracteurs (mixdrop, dood, voe, uqload,
// vidzy…) — rien à mettre à jour ici quand un extracteur arrive.
const DIRECT_HOSTS = new Set(SUPPORTED_HOSTS);
function effectiveSourceMode(source) {
  return source.mode === 'direct' && DIRECT_HOSTS.has(source.host) ? 'direct' : 'iframe';
}

function serializeSource(row) {
  return {
    id: row.id,
    host: row.host,
    mode: effectiveSourceMode(row),
    versions: row.versions ?? [],
    // Séries : le numéro d'épisode est stocké dans sortOrder par le bot
    // (ordre = épisodes croissants). Films : ordre console, sans sémantique.
    episode: row.episode ?? null,
    playRef: row.finalUrl ?? row.embedUrl,
  };
}

export async function listExternalTitles(env, { q, kind, genre, sort, limit = 48, offset = 0 } = {}) {
  const params = [];
  const conditions = [`t."isVisible" = true`];
  // Filtre MOVIE/SERIES : les onglets Films et Séries de l'app ne doivent pas
  // mélanger les deux (le bot pré-classe via le listing films/s-tv).
  if (kind === 'MOVIE' || kind === 'SERIES') {
    params.push(kind);
    conditions.push(`t.kind = $${params.length}`);
  }
  // Filtre exact sur le tableau genres (orthographe scraper, stable).
  if (genre && String(genre).trim()) {
    params.push(String(genre).trim());
    conditions.push(`$${params.length} = ANY(t."genres")`);
  }
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim()}%`);
    conditions.push(`t.title ILIKE $${params.length}`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  // Tri `year` = nouveautés par date de sortie (année DESC, nulls en fin).
  const order = sort === 'year'
    ? `ORDER BY t.year DESC NULLS LAST, t."createdAt" DESC`
    : `ORDER BY t."sortOrder" ASC, t."createdAt" DESC`;
  const limitParam = Math.min(Math.max(1, Number(limit) || 48), 100);
  const offsetParam = Math.max(0, Number(offset) || 0);
  const [rows, counts] = await Promise.all([
    env.db.query(
      env,
      `SELECT t.id, t.title, t.year, t."posterUrl", t.kind,
        (SELECT COUNT(*)::int FROM "ExternalSource" s
          WHERE s."titleId" = t.id AND s."isActive" AND s."lastStatus" IN ('OK','UNKNOWN')) AS "healthySources"
       FROM "ExternalTitle" t ${where}
       ${order} LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    ),
    env.db.query(env, `SELECT COUNT(*)::int AS count FROM "ExternalTitle" t ${where}`, params),
  ]);
  const total = counts.rows[0]?.count ?? 0;
  return {
    items: rows.rows.map((row) => ({
      id: row.id,
      title: row.title,
      year: row.year ?? null,
      posterUrl: row.posterUrl ?? null,
      kind: row.kind === 'SERIES' ? 'SERIES' : 'MOVIE',
      healthySources: row.healthySources ?? 0,
    })),
    total,
    hasMore: offsetParam + rows.rows.length < total,
  };
}

// Genres présents dans le catalogue visible (par kind) avec compteurs :
// alimente les rails par genre des onglets Films/Séries.
export async function listExternalGenres(env, kind) {
  const params = [];
  const conditions = [`t."isVisible" = true`];
  if (kind === 'MOVIE' || kind === 'SERIES') {
    params.push(kind);
    conditions.push(`t.kind = $${params.length}`);
  }
  const rows = await env.db.query(
    env,
    `SELECT g AS name, COUNT(*)::int AS count FROM "ExternalTitle" t
     CROSS JOIN UNNEST(t."genres") AS g
     WHERE ${conditions.join(' AND ')}
     GROUP BY g ORDER BY count DESC, name ASC`,
    params,
  );
  return { genres: rows.rows.map((row) => ({ name: row.name, count: row.count })) };
}

// (listExternalTitles ci-dessous inclut le champ kind par titre.)

// Priorité de version dans une liste de lecteurs (le champ `versions` vient
// du scraper : 'default' | 'vostfr' | 'vfq' | 'vff'). Le public veut le
// français : VF (vff) > VFQ > VOSTFR > indéterminé (default/[]). La valeur
// MIN d'une source dans ce rang décide de son ordre ; une source qui cumule
// plusieurs versions hérite de sa MEILLEURE.
const VERSION_RANKS = [
  { match: (v) => /vfq/.test(v), rank: 1 },
  { match: (v) => /^vff$/.test(v) || v === 'vf', rank: 0 },
  { match: (v) => /vostfr|vost/.test(v), rank: 2 },
];
function versionRank(versions) {
  const list = versions ?? [];
  let best = 3;
  for (const version of list) {
    for (const { match, rank } of VERSION_RANKS) {
      if (match(String(version).toLowerCase())) best = Math.min(best, rank);
    }
  }
  return best;
}
// Ordre de lecture au clic : direct (Player Mbolo, sans pubs) avant iframe,
// puis version (VF prioritaire), puis l'ordre console (sortOrder) pour
// départager les équivalents.
function sourceOrder(a, b) {
  const modeDelta = (a.mode === 'direct' ? 0 : 1) - (b.mode === 'direct' ? 0 : 1);
  if (modeDelta !== 0) return modeDelta;
  const rankDelta = versionRank(a.versions) - versionRank(b.versions);
  if (rankDelta !== 0) return rankDelta;
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
}

export async function findExternalTitleById(env, id) {
  const rows = await env.db.query(
    env,
    `SELECT t.id, t.title, t.kind, t.year, t."posterUrl", t."backdropUrl", t."trailerYoutubeId",
      t.synopsis, t."originalTitle", t.duration, t.director, t."cast", t.genres,
      t."introStartSec", t."introEndSec",
      s.id AS "sourceId", s.host, s.mode, s.versions, s."embedUrl", s."finalUrl",
      s."sortOrder", s."createdAt" AS "sourceCreatedAt"
     FROM "ExternalTitle" t
     LEFT JOIN "ExternalSource" s
       ON s."titleId" = t.id AND s."isActive" AND s."lastStatus" IN ('OK','UNKNOWN')
     WHERE t.id = $1 AND t."isVisible" = true
     ORDER BY s."sortOrder" ASC, s."createdAt" ASC`,
    [id],
  );
  if (rows.rows.length === 0) return null;
  const first = rows.rows[0];
  return {
    id: first.id,
    title: first.title,
    kind: first.kind === 'SERIES' ? 'SERIES' : 'MOVIE',
    year: first.year ?? null,
    posterUrl: first.posterUrl ?? null,
    backdropUrl: first.backdropUrl ?? null,
    trailerYoutubeId: first.trailerYoutubeId ?? null,
    // Détails « façon Netflix » : tout null-able, l'UI masque ce qui manque.
    synopsis: first.synopsis ?? null,
    originalTitle: first.originalTitle ?? null,
    duration: first.duration ?? null,
    director: first.director ?? null,
    cast: first.cast ?? null,
    genres: first.genres ?? [],
    introStartSec: first.introStartSec ?? null,
    introEndSec: first.introEndSec ?? null,
    sources: rows.rows
      .filter((row) => row.sourceId !== null)
      .map((row) => ({ createdAt: row.sourceCreatedAt, ...row }))
      .sort(sourceOrder)
      .map((row) => serializeSource({ id: row.sourceId, host: row.host, mode: row.mode, versions: row.versions, embedUrl: row.embedUrl, finalUrl: row.finalUrl, episode: first.kind === 'SERIES' ? row.sortOrder : null })),
  };
}

/**
 * Backfill des détails « façon Netflix » : re-scrape les N titres les plus
 * anciens dont le synopsis est vide et dont on connaît la ficheUrl (stockée
 * au publish, ou devinée via BASE_CANDIDATES pour les imports antérieurs).
 * Appelé par POST /api/owner/vod/external/resync (console) et piggybacké
 * sur le cron santé (petit lot séquentiel, pas de rafale anti-bot).
 */
export async function resyncExternalMeta(env, limit = 4) {
  const bases = String(env.EXTERNAL_FICHE_BASES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const rows = await env.db.query(
    env,
    `SELECT t.id, t."siteRef", t."ficheUrl" FROM "ExternalTitle" t
     WHERE t."isVisible" AND t.synopsis IS NULL
     ORDER BY t."createdAt" ASC LIMIT $1`,
    [Math.min(Math.max(1, Number(limit) || 4), 20)],
  );
  const summary = { scanned: rows.rows.length, updated: 0, failed: 0 };
  for (const row of rows.rows) {
    // URL de fiche : stockée au publish, sinon devinée depuis les bases
    // candidates (les newsid sont globaux aux domaines du site).
    const ficheUrl = row.ficheUrl
      ?? (row.siteRef && bases.length > 0 ? `${bases[0]}/index.php?newsid=${row.siteRef}` : null);
    if (!ficheUrl) { summary.failed += 1; continue; }
    try {
      const adapter = ficheAdapterFor(ficheUrl);
      if (!adapter) { summary.failed += 1; continue; }
      const preview = await adapter.scrapeFiche(env, ficheUrl);
      await env.db.query(
        env,
        `UPDATE "ExternalTitle" SET synopsis = $2, "originalTitle" = $3, duration = $4,
           director = $5, "cast" = $6, genres = $7, "ficheUrl" = $8
         WHERE id = $1 AND synopsis IS NULL`,
        [row.id, preview.synopsis ?? null, preview.originalTitle ?? null, preview.duration ?? null,
          preview.director ?? null, preview.cast ?? null, preview.genres ?? [], ficheUrl],
      );
      summary.updated += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}

/** Adapter de scraper pour une URL de fiche (null si site inconnu). */
function ficheAdapterFor(url) {
  const value = String(url ?? '').trim();
  return FICHE_ADAPTERS.find((entry) => entry.matchUrl(value) !== null) ?? null;
}

/**
 * Balayage santé (cron) : les N sources actives les moins récemment vérifiées
 * (jamais vérifiées d'abord), résolution séquentielle (pas de rafale
 * anti-bot), statut persisté. DEAD/OK/ERROR + message tronqué.
 */
export async function checkExternalBatch(env, limit = 8) {
  const rows = await env.db.query(
    env,
    `SELECT s.id, s.host, s.mode, s."embedUrl", s."finalUrl" FROM "ExternalSource" s
     JOIN "ExternalTitle" t ON t.id = s."titleId"
     WHERE s."isActive" AND t."isVisible" = true
     ORDER BY s."lastCheckedAt" ASC NULLS FIRST LIMIT $1`,
    [Math.min(Math.max(1, Number(limit) || 8), 50)],
  );
  const summary = { checked: 0, ok: 0, dead: 0, errors: 0, promoted: 0 };
  for (const source of rows.rows) {
    try {
      let check;
      if (effectiveSourceMode(source) === 'iframe' && DIRECT_HOSTS.has(source.host)) {
        // Ligne enregistrée iframe alors qu'un extracteur existe désormais
        // (importé avant l'extracteur) : tentative de PROMOTION vers direct.
        // Check complet (embed + handshake + CDN) — seul un verdict OK
        // convertit la ligne ; sinon on retombe sur le verdict embed, la
        // ligne reste iframe et joue quand même.
        check = await checkSource(env, source.host, source.finalUrl ?? source.embedUrl);
        if (check.ok) {
          await env.db.query(env, `UPDATE "ExternalSource" SET mode = 'direct' WHERE id = $1`, [source.id]);
          summary.promoted += 1;
        } else {
          check = await checkEmbedPage(env, source.embedUrl);
        }
      } else if (effectiveSourceMode(source) === 'iframe') {
        // Host sans extracteur : simple existence de la page embed.
        check = await checkEmbedPage(env, source.embedUrl);
      } else {
        check = await checkSource(env, source.host, source.finalUrl ?? source.embedUrl);
      }
      const status = check.ok ? 'OK' : check.code === 'DEAD' ? 'DEAD' : 'ERROR';
      await env.db.query(env, `UPDATE "ExternalSource" SET "lastStatus" = $2, "lastError" = $3, "lastCheckedAt" = now() WHERE id = $1`,
        [source.id, status, check.ok ? null : String(check.message ?? '').slice(0, 200)]);
      summary.checked += 1;
      if (check.ok) summary.ok += 1;
      else if (status === 'DEAD') summary.dead += 1;
      else summary.errors += 1;
    } catch {
      summary.checked += 1;
      summary.errors += 1;
    }
  }
  return summary;
}

export const _internal = { iso, effectiveSourceMode, serializeSource, versionRank, sourceOrder, resyncExternalMeta };
