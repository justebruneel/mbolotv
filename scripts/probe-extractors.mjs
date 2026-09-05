#!/usr/bin/env node
// Sonde live des extracteurs (manuel, jamais en CI) :
//   node scripts/probe-extractors.mjs mixdrop <fileId|/e/…|/f/…>
//   node scripts/probe-extractors.mjs dood <embedUrl|/d/…|/e/…|code>
// Résout SANS signer (pas de VIDEO_PROXY_URL requis) et vérifie le CDN
// par probe Range. MIXDROP_MIRRORS / DOOD_MIRRORS surchargent comme en prod.
import { resolve as resolveMixdrop, mirrorsFromEnv as mixdropMirrors } from '../workers/mbolo-tv-api/src/extractors/mixdrop.js';
import { resolve as resolveDood, mirrorsFromEnv as doodMirrors } from '../workers/mbolo-tv-api/src/extractors/dood.js';

const [, , host, ref] = process.argv;
const RESOLVERS = {
  mixdrop: { resolve: resolveMixdrop, mirrors: mixdropMirrors, envKey: 'MIXDROP_MIRRORS' },
  dood: { resolve: resolveDood, mirrors: doodMirrors, envKey: 'DOOD_MIRRORS' },
};
const selected = RESOLVERS[host];
if (!selected || !ref) {
  console.error('Usage : node scripts/probe-extractors.mjs (mixdrop|dood) <id|embedUrl>');
  process.exit(2);
}

const env = { [selected.envKey]: process.env[selected.envKey] ?? '' };
console.log(`Miroirs : ${selected.mirrors(env).join(', ')}`);
const started = Date.now();
try {
  const result = await selected.resolve(env, ref);
  // Ne jamais logger l'URL signée complète (jeton) : hôte + expiry suffisent.
  const direct = new URL(result.urls[0]);
  console.log(`OK en ${Date.now() - started} ms`);
  console.log(`CDN : ${direct.host}${direct.pathname}`);
  console.log(`Params signés : ${direct.searchParams.has('s') || direct.searchParams.has('token') ? 'oui' : 'non'}`);
  console.log(`Referer : ${result.referer}`);
  if (result.title) console.log(`Titre : ${result.title}`);
} catch (error) {
  console.error(`ÉCHEC [${error?.code ?? '?'}|HTTP ${error?.status ?? '?'}] : ${error?.message}`);
  process.exit(1);
}
