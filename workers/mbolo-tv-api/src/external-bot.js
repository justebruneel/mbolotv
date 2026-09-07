// Bot d'import automatique des fiches French Stream : découverte des
// listings (films / s-tv), file d'attente persistante (ExternalImportQueue),
// publication par petits lots à chaque tick du cron */10. L'objectif :
// absorber ~34 000 fiches initiales + les nouveautés quotidiennes sans
// intervention manuelle, dans le budget de sous-requêtes Workers.
//
// Par tick : reprise des items marqués RUNNING par le tick précédent (ou
// stale > 15 min), puis un lot de EXTERNAL_BOT_BATCH fiches PENDING (priorité
// décroissante, moins tentées d'abord). Chaque fiche ≈ 6-8 sous-requêtes
// (fiche + film_api + ep-data + wrappers) + 6 vérifications inline max :
// le lot de 3 ≈ 25-30 req, sous les plafonds, et les autres crons respirent.
import { scrapeFiche, scrapeListingPage, listingKind } from './scrapers/frenchstream.js';
import { storeExternalPreview } from './owner-vod.js';

const SITE = 'frenchstream';
const STALE_RUNNING_MINUTES = 15;
const MAX_ATTEMPTS = 3;
// Budget de sous-requêtes du tick (estimation : ~8 par fiche + reprise).
const TICK_REQUEST_BUDGET = 45;

function enabled(env) {
  return String(env.EXTERNAL_BOT_ENABLED ?? '0') === '1';
}

function batch(env) {
  return Math.min(Math.max(1, Number(env.EXTERNAL_BOT_BATCH) || 3), 8);
}

function categories(env) {
  return String(env.EXTERNAL_BOT_CATEGORIES ?? 'films,s-tv')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Sème la file depuis les listings : page 1 (nouveautés, priority 10) et
 * page suivante du rattrapage (priority 0) par catégorie. Dédup par
 * (site, newsid) — les fiches déjà connues sont ignorées.
 * Retour : { seeded, byCategory: { films: N, 's-tv': N }, maxPage }.
 */
export async function discoverNew(env, pages = 1) {
  const summary = { seeded: 0, byCategory: {}, maxPage: {} };
  for (const category of categories(env)) {
    let seededCat = 0;
    for (let index = 0; index < Math.min(Math.max(1, Number(pages) || 1), 5); index += 1) {
      // Rattrapage : la plus grande page non encore couverte (curseur en
      // base via le max de priority 0 déjà semé — simplification : on crawl
      // les pages croissantes à partir de 1, la dédup écrase le connu).
      const page = index + 1;
      const listing = await scrapeListingPage(env, category, page);
      summary.maxPage[category] = listing.maxPage;
      const kind = listingKind(category) ?? 'MOVIE';
      const priority = index === 0 ? 10 : 0;
      for (const item of listing.items) {
        const inserted = await env.db.query(
          env,
          `INSERT INTO "ExternalImportQueue" (id, site, category, newsid, kind, priority)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (site, newsid) DO NOTHING`,
          [crypto.randomUUID(), SITE, category, item.newsid, kind, priority],
        );
        if ((inserted.rowCount ?? 0) > 0) seededCat += 1;
      }
    }
    summary.byCategory[category] = seededCat;
    summary.seeded += seededCat;
  }
  return summary;
}

/** Reprise des RUNNING muets (tick précédent tué) → re-PENDING. */
async function reclaimStale(env) {
  const result = await env.db.query(
    env,
    `UPDATE "ExternalImportQueue"
     SET state = 'PENDING'
     WHERE state = 'RUNNING' AND "processedAt" < now() - interval '${STALE_RUNNING_MINUTES} minutes'`,
  );
  return result.rowCount ?? 0;
}

/** Comptes de la file (console + garde). */
export async function botStatus(env) {
  const counts = await env.db.query(
    env,
    `SELECT state, COUNT(*)::int AS n FROM "ExternalImportQueue" GROUP BY state`,
  );
  const byState = Object.fromEntries(counts.rows.map((row) => [row.state.toLowerCase(), row.n]));
  const last = await env.db.query(
    env,
    `SELECT "processedAt" FROM "ExternalImportQueue" WHERE state IN ('DONE','FAILED') ORDER BY "processedAt" DESC NULLS LAST LIMIT 1`,
  );
  const published = await env.db.query(
    env,
    `SELECT COUNT(*)::int AS n FROM "ExternalTitle" WHERE site = $1 AND "createdAt" > now() - interval '24 hours'`,
    [SITE],
  );
  return {
    enabled: enabled(env),
    queue: { pending: byState.pending ?? 0, running: byState.running ?? 0, done: byState.done ?? 0, failed: byState.failed ?? 0 },
    publishedLast24h: published.rows[0]?.n ?? 0,
    lastProcessedAt: last.rows[0]?.processedAt ?? null,
  };
}

/** Tick forcé depuis la console : ne tient pas compte du toggle (le owner
 *  demande explicitement un traitement), même budget. */
export async function runExternalBotTickForce(env) {
  const previous = String(env.EXTERNAL_BOT_ENABLED ?? '0');
  env.EXTERNAL_BOT_ENABLED = '1';
  try {
    return await runExternalBotTick(env);
  } finally {
    env.EXTERNAL_BOT_ENABLED = previous;
  }
}

/** Pause anti-bot entre deux fiches : le site tolère le séquentiel mais
 *  bannit les rafales (403 constatés sur 3 fiches rapprochées). */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Un tick du bot : reprise des stale, puis traitement d'un lot séquentiel.
 * Chaque fiche : scrape → storeExternalPreview (tout en UNKNOWN, le cron
 * santé vérifiera les lecteurs) → DONE / FAILED. Stop net au budget.
 */
export async function runExternalBotTick(env) {
  if (!enabled(env)) return { ran: false, reason: 'bot désactivé' };
  const reclaimed = await reclaimStale(env);
  // File vide : amorçage automatique (page 1 des listings = nouveautés).
  const pendingCheck = await env.db.query(env, `SELECT 1 FROM "ExternalImportQueue" WHERE state IN ('PENDING','RUNNING') LIMIT 1`);
  let discovery = null;
  if (pendingCheck.rows.length === 0) {
    discovery = await discoverNew(env, 1);
  }
  const results = [];
  let requests = 8; // marge : listing/reprise
  let processed = 0;
  const wanted = batch(env);
  while (processed < wanted && requests < TICK_REQUEST_BUDGET) {
    // Claim atomique : l'item le plus prioritaire, le moins tenté, le plus ancien.
    const claim = await env.db.query(
      env,
      `UPDATE "ExternalImportQueue" SET state = 'RUNNING', "processedAt" = now(), attempts = attempts + 1
       WHERE id = (
         SELECT id FROM "ExternalImportQueue"
         WHERE state = 'PENDING' AND attempts < $1
         ORDER BY priority DESC, attempts ASC, "discoveredAt" ASC
         LIMIT 1
       )
       RETURNING id, category, newsid, kind, attempts`,
      [MAX_ATTEMPTS],
    );
    if (claim.rows.length === 0) break;
    const item = claim.rows[0];
    processed += 1;
    // Espacement anti-bot entre fiches (pas avant la première).
    if (processed > 1) await sleep(2_000);
    try {
      const preview = await scrapeFiche(env, `https://french-stream.one/index.php?newsid=${item.newsid}`);
      // Pas de vérification inline (budget) : tout part en UNKNOWN, le cron
      // santé des 10 min vérifie les lecteurs au fil de l'eau.
      const stored = await storeExternalPreview(env, preview, { verified: [], pending: preview.players, rejected: [] });
      if (!stored.ok) throw new Error(stored.reason ?? 'publication impossible');
      await env.db.query(env, `UPDATE "ExternalImportQueue" SET state = 'DONE', "lastError" = NULL, "processedAt" = now() WHERE id = $1`, [item.id]);
      results.push({ newsid: item.newsid, kind: item.kind, title: stored.title, inserted: stored.inserted });
      requests += 8;
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 200);
      const retryable = /injoignable|RETRYABLE|timeout/i.test(message) && item.attempts < MAX_ATTEMPTS;
      await env.db.query(
        env,
        `UPDATE "ExternalImportQueue" SET state = $2, "lastError" = $3, "processedAt" = now() WHERE id = $1`,
        [item.id, retryable ? 'PENDING' : 'FAILED', message],
      );
      results.push({ newsid: item.newsid, kind: item.kind, error: message });
      requests += 4;
    }
  }
  return { ran: true, reclaimed, discovery, processed, results };
}
