/**
 * Génère les assets PWA natifs depuis public/icon.svg :
 *  - apple-icon.png (180) : apple-touch-icon iOS — Safari IGNORE le SVG,
 *    sans PNG l'écran d'accueil affiche une capture de page.
 *  - icon-192.png / icon-512.png : icônes manifest pour Chrome/Android
 *    (splash d'installation + launchers qui rastérisent mal le SVG).
 *  - splash/*.png : apple-touch-startup-image iOS — sans elles, le
 *    lancement PWA sur iPhone flashe en blanc avant le premier rendu.
 *
 * Usage : node scripts/generate-pwa-assets.mjs (depuis apps/web).
 * sharp n'est pas une dépendance directe : résolu dans le store pnpm.
 */
import { globSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, '..', 'public');

async function loadSharp() {
  const req = createRequire(import.meta.url);
  try {
    return req('sharp');
  } catch {
    // pnpm : sharp est transitif (next) — résolution directe dans le store.
    const found = globSync(join(here, '../../../node_modules/.pnpm/sharp@*/node_modules/sharp/package.json'));
    if (found.length === 0) throw new Error('sharp introuvable — ajoute-le temporairement en devDependency.');
    return req(dirname(found[found.length - 1]));
  }
}

const sharp = await loadSharp();
const svg = await (await import('node:fs/promises')).readFile(join(pub, 'icon.svg'), 'utf8');

// apple-touch-icon : iOS arrondit lui-même les coins — carré PLEIN demandé,
// pas de rx (les coins arrondis laisseraient voir le fond noir derrière).
const squareSvg = svg.replace(/rx="56"/, 'rx="0"');
await sharp(Buffer.from(squareSvg)).resize(180, 180).png().toFile(join(pub, 'apple-icon.png'));

// Icônes manifest (formes arrondies conservées ; fond opaque = maskable OK).
for (const size of [192, 512]) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(join(pub, `icon-${size}.png`));
}

// Splash iOS : fond app (#101823) + logo centré. Tailles officielles des
// appareils courants (portrait + paysage) — iOS exige la taille exacte.
const SPLASHES = [
  ['1290x2796', 'iPhone 15/16 Pro Max'],
  ['2796x1290', 'iPhone 15/16 Pro Max (paysage)'],
  ['1179x2556', 'iPhone 14/15/16 Pro'],
  ['2556x1179', 'iPhone 14/15/16 Pro (paysage)'],
  ['1284x2778', 'iPhone 12/13 Pro Max'],
  ['2778x1284', 'iPhone 12/13 Pro Max (paysage)'],
  ['1170x2532', 'iPhone 12/13/14'],
  ['2532x1170', 'iPhone 12/13/14 (paysage)'],
  ['820x1180', 'iPad Air 10.9"'],
  ['1180x820', 'iPad Air 10.9" (paysage)'],
  ['2048x2732', 'iPad Pro 12.9"'],
  ['2732x2048', 'iPad Pro 12.9" (paysage)'],
];
const logo = await sharp(Buffer.from(svg)).resize(180, 180).png().toBuffer();
const splashDir = join(pub, 'splash');
(await import('node:fs/promises')).mkdir(splashDir, { recursive: true });
for (const [size, label] of SPLASHES) {
  const [width, height] = size.split('x').map(Number);
  const file = join(splashDir, `${size}.png`);
  await sharp({ create: { width, height, channels: 4, background: '#101823' } })
    .composite([{ input: logo, left: Math.round((width - 180) / 2), top: Math.round((height - 180) / 2) }])
    .png()
    .toFile(file);
  console.log('splash', size, '—', label);
}
console.log('Assets PWA générés dans', pub);
