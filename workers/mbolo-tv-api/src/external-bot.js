// Bot d'import automatique des fiches French Stream : découverte des
// listings (films / s-tv), file d'attente persistante (ExternalImportQueue),
// publication par petits lots à chaque tick du cron */5. L'objectif :
// absorber le catalogue complet (~34 000 fiches) + les nouveautés
// quotidiennes sans aucune intervention, dans le budget de sous-requêtes
// Workers (50/invocation, plan gratuit).
//
// Rattrapage : à CHAQUE tick, discoverBacklog sème la page suivante de
// chaque listing via un curseur persistant (MetadataCache) — le semis du
// catalogue (~20 k fiches/jour) doit dépasser la vitesse du traitement.
// Catalogue couvert → 0 requête, et la découverte des nouveautés (page 1,
// priority 10) prend le relais à chaque tick.
//
// Par tick : reprise des items RUNNING stale (> 15 min), purge des PENDING
// épuisés, semis, puis un lot de EXTERNAL_BOT_BATCH fiches PENDING
// (nouveautés d'abord, rattrapage ensuite ; moins tentées d'abord). Chaque
// fiche ≈ 6-8 sous-requêtes (fiche + film_api + ep-data + wrappers) : le
// lot de 4 ≈ 38 req, sous les plafonds, et les autres crons respirent.
import { scrapeFiche, scrapeListingPage, listingKind } from './scrapers/frenchstream.js';
import { storeExternalPreview } from './owner-vod.js';

const SITE = 'frenchstream';
const STALE_RUNNING_MINUTES = 15;
const MAX_ATTEMPTS = 3;
// Budget de sous-requêtes du tick (estimation : ~8 par fiche + semis).
const TICK_REQUEST_BUDGET = 45;
const BACKLOG_CURSOR_KEY = 'external-bot-backlog-cursor';

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

/** Purge des épuisés : un PENDING au plafond de tentatives n'est plus
 *  claimable mais reste vivant en base à jamais — il passe FAILED. Sans
 *  ça, la file garde des fantômes et la console affiche un faux « en
 *  attente ». */
async function exhaustStalePending(env) {
  const result = await env.db.query(
    env,
    `UPDATE "ExternalImportQueue" SET state = 'FAILED', "lastError" = 'tentatives épuisées'
     WHERE state = 'PENDING' AND attempts >= $1`,
    [MAX_ATTEMPTS],
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

/** Curseur du rattrapage (MetadataCache) : dernière page semée par
 *  catégorie + liste des catégories terminées. */
async function readBacklogCursor(env) {
  const rows = await env.db.query(env, `SELECT payload FROM "MetadataCache" WHERE "cacheKey" = $1`, [BACKLOG_CURSOR_KEY]);
  const payload = rows.rows[0]?.payload;
  return payload && typeof payload === 'object' ? payload : {};
}

async function writeBacklogCursor(env, cursor) {
  await env.db.query(
    env,
    `INSERT INTO "MetadataCache" (id, "cacheKey", title, payload, "expiresAt")
     VALUES ($1, $2, 'Curseur rattrapage bot', $3::jsonb, now() + interval '3650 days')
     ON CONFLICT ("cacheKey") DO UPDATE SET payload = EXCLUDED.payload, "expiresAt" = now() + interval '3650 days'`,
    [crypto.randomUUID(), BACKLOG_CURSOR_KEY, JSON.stringify(cursor)],
  );
}

/**
 * Rattrapage du catalogue : sème la page suivante de chaque listing (une
 * par catégorie et par tick, ~2 requêtes) via un curseur persistant. Une
 * catégorie arrivée au bout passe « done » et n'est plus crawlée ; quand
 * TOUTES le sont, le rattrapage retourne exhausted (0 requête) et le tick
 * replie sur discoverNew (nouveautés). Priorité 0 : les nouveautés passent
 * toujours avant dans le claim. La dédup (site, newsid) rend les
 * recouvrements de pagination sans effet.
 */
export async function discoverBacklog(env) {
  const cursor = await readBacklogCursor(env);
  const done = new Set(Array.isArray(cursor.done) ? cursor.done : []);
  const cats = categories(env);
  if (cats.every((category) => done.has(category))) {
    return { exhausted: true, seeded: 0, pages: 0, byCategory: {} };
  }
  const next = { ...cursor, done: [...done] };
  const summary = { exhausted: false, seeded: 0, pages: 0, byCategory: {} };
  for (const category of cats) {
    if (done.has(category)) continue;
    const fromPage = Number(cursor[category]) || 0;
    let listing;
    try {
      listing = await scrapeListingPage(env, category, fromPage + 1);
    } catch (error) {
      // Listing injoignable : on retente au prochain tick (curseur intact).
      summary.byCategory[category] = { error: String(error?.message ?? error).slice(0, 120) };
      continue;
    }
    summary.pages += 1;
    const kind = listingKind(category) ?? 'MOVIE';
    let seededCat = 0;
    for (const item of listing.items) {
      const inserted = await env.db.query(
        env,
        `INSERT INTO "ExternalImportQueue" (id, site, category, newsid, kind, priority)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (site, newsid) DO NOTHING`,
        [crypto.randomUUID(), SITE, category, item.newsid, kind, 0],
      );
      if ((inserted.rowCount ?? 0) > 0) seededCat += 1;
    }
    next[category] = fromPage + 1;
    summary.byCategory[category] = { page: fromPage + 1, maxPage: listing.maxPage, seeded: seededCat };
    summary.seeded += seededCat;
    if (fromPage + 1 >= listing.maxPage) next.done = [...(next.done ?? []), category];
  }
  summary.exhausted = cats.every((category) => (next.done ?? []).includes(category));
  await writeBacklogCursor(env, next);
  return summary;
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

/**
 * Un tick du bot : reprise des stale, purge des épuisés, rattrapage
 * systématique du catalogue, nouveautés dès que le rattrapage est couvert,
 * puis traitement d'un lot séquentiel. Aucune intervention requise. Chaque
 * fiche : scrape → storeExternalPreview (tout en UNKNOWN, le cron santé
 * vérifie les lecteurs) → DONE / FAILED. Stop net au budget.
 */
export async function runExternalBotTick(env) {
  if (!enabled(env)) return { ran: false, reason: 'bot désactivé' };
  const reclaimed = await reclaimStale(env);
  const purged = await exhaustStalePending(env);
  const backlog = await discoverBacklog(env);
  // Nouveautés une fois le catalogue couvert ; pendant le rattrapage, la
  // page 1 est de toute façon la première page semée par le curseur.
  const discovery = backlog.exhausted ? await discoverNew(env, 1) : null;
  const results = [];
  let requests = 4 + backlog.pages + (discovery ? 2 : 0); // semis + marge
  let processed = 0;
  const wanted = batch(env);
  while (processed < wanted && requests < TICK_REQUEST_BUDGET) {
    // Claim atomique : l'item le plus prioritaire, le moins tenté, le plus
    // ancien — jamais au plafond de tentatives (déjà exclus par exhaustStale
    // Pending, mais la garde reste dans la requête).
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
  return { ran: true, reclaimed, purged, backlog, discovery, processed, results };
}
