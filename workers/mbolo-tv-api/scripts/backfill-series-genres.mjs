// Backfill one-shot des genres séries externes : crawl des catégories séries
// French Stream (toutes, plusieurs pages), fusion dans la carte MetadataCache,
// application aux titres, purge du faux positif « spectacle » sur les titres
// non couverts. Le cron */10 entretient la carte ensuite (2 catégories/tick) —
// ce script ne sert qu'à remplir immédiatement.
//
// Usage : node scripts/backfill-series-genres.mjs "<postgres-url>" [pages]
import pg from 'pg';
import { refreshExternalGenreMap, applyExternalGenreMap } from '../src/external-genres.js';

const connectionString = process.argv[2];
if (!connectionString) {
  console.error('Usage: node scripts/backfill-series-genres.mjs "<postgres-url>" [pages=2]');
  process.exit(1);
}
const pages = Math.min(Math.max(1, Number(process.argv[3]) || 2), 5);

const client = new pg.Client(connectionString);
await client.connect();
const env = { db: { query: (e, sql, params) => client.query(sql, params) } };

const before = await client.query(
  `SELECT genres, COUNT(*)::int AS n FROM "ExternalTitle" WHERE site = 'frenchstream' AND kind = 'SERIES' GROUP BY genres ORDER BY n DESC`,
);
console.log('Avant (genres séries):', JSON.stringify(before.rows));

const refresh = await refreshExternalGenreMap(env, { limit: 18, pages });
for (const entry of refresh.crawled) {
  console.log(`  ${entry.genre.padEnd(16)} ${String(entry.items).padStart(3)} newsid  (${entry.path})`);
}
console.log(`Carte: +${refresh.merged} newsid fusionnés`);

const applied = await applyExternalGenreMap(env, { clearStale: true });
console.log(`Application: ${applied.applied} série(s) renseignée(s), ${applied.cleared} faux positif(s) purgé(s)`);

const after = await client.query(
  `SELECT g AS genre, COUNT(*)::int AS n
   FROM "ExternalTitle" t CROSS JOIN UNNEST(t.genres) AS g
   WHERE t.site = 'frenchstream' AND t.kind = 'SERIES' AND t."isVisible"
   GROUP BY g ORDER BY n DESC`,
);
console.log('Après (genres séries visibles):', JSON.stringify(after.rows));

await client.end();
