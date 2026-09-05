#!/usr/bin/env node
// Aperçu d'import d'une fiche (manuel, jamais en CI) :
//   node scripts/probe-fiche.mjs "https://french-stream.one/index.php?newsid=15136768"
// Scrape métas + lecteurs (wrappers suivis 1 hop), SANS écrire en base.
import { serveFichePreview } from '../workers/mbolo-tv-api/src/scrapers/index.js';

const [, , ficheUrl] = process.argv;
if (!ficheUrl) {
  console.error('Usage : node scripts/probe-fiche.mjs "<url-fiche>"');
  process.exit(2);
}

const response = await serveFichePreview({}, ficheUrl);
const body = await response.json();
if (!response.ok) {
  console.error(`ÉCHEC [HTTP ${response.status}] : ${body.message}`);
  process.exit(1);
}
console.log(`${body.title}${body.year ? ` (${body.year})` : ''} — ${body.site}#${body.newsid ?? '?'}`);
console.log(`Affiche : ${body.posterUrl ?? '—'}`);
for (const player of body.players) {
  const versions = player.versions.join(',');
  const target = player.finalUrl ?? player.embedUrl;
  console.log(`- ${player.host} [${versions}]${player.wrapped ? ' (wrapper suivi)' : ''} → ${target}`);
}
