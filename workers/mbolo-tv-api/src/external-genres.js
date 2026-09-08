// Cartographie genres séries French Stream. Les fiches séries du site ne
// portent AUCUN genre (pas de ligne « Genre(s) », fil d'Ariane vide) : avant
// la carte, le scraper héritait du seul lien xfsearch/genre-1/ de la page —
// l'entrée « Spectacle » du menu — et toutes les séries se retrouvaient avec
// ce genre unique. Chaque catégorie série du site (/drame-serie-/…) liste ses
// newsids : on crawl ces listings par petits lots au cron, on fusionne la
// carte { newsid: [genres] } dans MetadataCache (merge jsonb atomique, pas de
// read-modify-write), puis on applique aux titres dont les genres sont vides
// ou portent encore le faux positif.
import { fetchEmbedText } from './extractors/http.js';
import { FS_DEFAULT_BASE } from './scrapers/frenchstream.js';

const SITE = 'frenchstream';
const MAP_KEY = 'external-series-genre-map';
const CURSOR_KEY = 'external-series-genre-map-cursor';
// Faux positif historique (entrée « Spectacle » du menu) : traité comme
// « genres à remplir » par l'application de carte.
export const STALE_GENRE_MARKER = 'spectacle';

// Catégories séries du menu du site (libellés vérifiés à la main) → genre
// affiché, orthographe alignée sur celle des genres films scrapés.
export const SERIES_GENRE_CATEGORIES = [
  { path: '/action-serie-', genre: 'Action' },
  { path: '/art-martiaux/', genre: 'Arts martiaux' },
  { path: '/aventure-series-', genre: 'Aventure' },
  { path: '/serie-biopic-', genre: 'Biopic' },
  { path: '/comedie-serie-', genre: 'Comédie' },
  { path: '/drame-serie-', genre: 'Drame' },
  { path: '/documentaire-serie-', genre: 'Documentaire' },
  { path: '/familles-series-', genre: 'Famille' },
  { path: '/fantastique-series-', genre: 'Fantastique' },
  { path: '/horreur-serie-', genre: 'Horreur' },
  { path: '/judiciare-series-', genre: 'Judiciaire' },
  { path: '/medical-series-', genre: 'Médical' },
  { path: '/romance-series-', genre: 'Romance' },
  { path: '/science-fiction-series-', genre: 'Science-Fiction' },
  { path: '/serie-historiques-', genre: 'Historique' },
  { path: '/streaming-tv-realits/', genre: 'Télé-réalité' },
  { path: '/thriller-series-', genre: 'Thriller' },
  { path: '/western-series-', genre: 'Western' },
];

const NEWSID_LINK_PATTERN = /newsid=(\d{4,12})/g;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCursor(env) {
  const rows = await env.db.query(env, `SELECT payload->>'index' AS i FROM "MetadataCache" WHERE "cacheKey" = $1`, [CURSOR_KEY]);
  const value = Number(rows.rows[0]?.i);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

async function writeCursor(env, index) {
  await env.db.query(
    env,
    `INSERT INTO "MetadataCache" (id, "cacheKey", title, payload, "expiresAt")
     VALUES ($1, $2, 'Curseur carte genres séries', jsonb_build_object('index', $3::int), now() + interval '3650 days')
     ON CONFLICT ("cacheKey") DO UPDATE SET payload = EXCLUDED.payload, "expiresAt" = now() + interval '3650 days'`,
    [crypto.randomUUID(), CURSOR_KEY, index],
  );
}

/** Fusion ATOMIQUE dans la carte : payload = payload || entrants (jsonb),
 *  aucun risque d'écrasement entre ticks qui se chevauchent. */
async function mergeGenreMap(env, map) {
  await env.db.query(
    env,
    `INSERT INTO "MetadataCache" (id, "cacheKey", title, payload, "expiresAt")
     VALUES ($1, $2, 'Carte genres séries French Stream', $3::jsonb, now() + interval '3650 days')
     ON CONFLICT ("cacheKey") DO UPDATE
       SET payload = "MetadataCache".payload || EXCLUDED.payload,
           "expiresAt" = now() + interval '3650 days'`,
    [crypto.randomUUID(), MAP_KEY, JSON.stringify(map)],
  );
}

/**
 * Crawl des catégories séries : `limit` catégories par appel (rotation du
 * curseur, 2 par tick du cron des 10 min = tour complet en ~90 min), `pages`
 * pages chacune (page 1 suffit au cron ; le backfill initial va plus loin).
 * Une série peut être listée dans plusieurs catégories → genres cumulés.
 */
export async function refreshExternalGenreMap(env, { limit = 2, pages = 1 } = {}) {
  const categories = SERIES_GENRE_CATEGORIES;
  const start = await readCursor(env);
  const picked = [];
  for (let i = 0; i < Math.min(Math.max(1, Number(limit) || 1), categories.length); i += 1) {
    picked.push(categories[(start + i) % categories.length]);
  }
  const safePages = Math.min(Math.max(1, Number(pages) || 1), 5);
  const crawled = [];
  const map = {};
  for (const category of picked) {
    const ids = new Set();
    for (let page = 1; page <= safePages; page += 1) {
      const url = page === 1
        ? `${FS_DEFAULT_BASE}${category.path}`
        : `${FS_DEFAULT_BASE}${category.path}/page/${page}/`;
      const response = await fetchEmbedText(env, url).catch(() => null);
      if (!response?.text || !/<html/i.test(response.text)) break;
      for (const match of response.text.matchAll(NEWSID_LINK_PATTERN)) ids.add(match[1]);
      if (page < safePages) await sleep(750);
    }
    crawled.push({ path: category.path, genre: category.genre, items: ids.size });
    for (const newsid of ids) {
      (map[newsid] ??= []).push(category.genre);
    }
    if (category !== picked[picked.length - 1]) await sleep(750);
  }
  let merged = 0;
  if (Object.keys(map).length > 0) {
    await mergeGenreMap(env, map);
    merged = Object.keys(map).length;
  }
  await writeCursor(env, (start + picked.length) % categories.length);
  return { crawled, merged };
}

/**
 * Applique la carte aux séries dont les genres sont vides ou le faux
 * positif « spectacle ». Jamais les autres : un genre scrapé légitime ne
 * doit pas être écrasé. clearStale : efface en plus le marqueur des séries
 * que la carte ne connaît pas (backfill initial uniquement — le cron reste
 * conservateur).
 */
export async function applyExternalGenreMap(env, { clearStale = false } = {}) {
  const applied = await env.db.query(
    env,
    `UPDATE "ExternalTitle" t
     SET genres = sub.gs
     FROM (
       SELECT t2.id,
              ARRAY(SELECT jsonb_array_elements_text(m.payload -> t2."siteRef")) AS gs
       FROM "ExternalTitle" t2
       JOIN "MetadataCache" m ON m."cacheKey" = $1
       WHERE t2.site = $2 AND t2.kind = 'SERIES'
         AND (t2.genres = '{}' OR t2.genres = ARRAY[$3])
         AND jsonb_typeof(m.payload -> t2."siteRef") = 'array'
         AND jsonb_array_length(m.payload -> t2."siteRef") > 0
     ) sub
     WHERE t.id = sub.id`,
    [MAP_KEY, SITE, STALE_GENRE_MARKER],
  );
  let cleared = 0;
  if (clearStale) {
    const result = await env.db.query(
      env,
      `UPDATE "ExternalTitle" t
       SET genres = '{}'
       WHERE t.site = $1 AND t.kind = 'SERIES' AND t.genres = ARRAY[$2]
         AND NOT EXISTS (
           SELECT 1 FROM "MetadataCache" m
           WHERE m."cacheKey" = $3 AND m.payload -> t."siteRef" IS NOT NULL
         )`,
      [SITE, STALE_GENRE_MARKER, MAP_KEY],
    );
    cleared = result.rowCount ?? 0;
  }
  return { applied: applied.rowCount ?? 0, cleared };
}
