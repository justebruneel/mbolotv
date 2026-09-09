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
// Tuile sombre + play teal : le logo d'accueil reste fidèle à la marque.
const squareSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#101823"/><path d="M94 72v112l92-56-92-56Z" fill="#8ee8cf"/></svg>`;
await sharp(Buffer.from(squareSvg)).resize(180, 180).png().toFile(join(pub, 'apple-icon.png'));

// Icônes manifest (formes arrondies conservées ; fond opaque = maskable OK).
for (const size of [192, 512]) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(join(pub, `icon-${size}.png`));
}

// Splash iOS : fond app (#101823) + logo sombre (tuile navy, play teal —
// même rendu que <Logo stacked>) + « Mbolo TV » en dessous. Tailles
// officielles des appareils courants (portrait + paysage) — iOS exige la
// taille exacte. Le splash se prolonge visuellement dans l'écran de
// lancement de l'app (AccessChecking) : même fond, même marque, même agencement.
const SPLASHES = [
  ['1179x2556', 'iPhone 15/16'],
  ['2556x1179', 'iPhone 15/16 (paysage)'],
  ['1290x2796', 'iPhone 15/16 Pro Max'],
  ['2796x1290', 'iPhone 15/16 Pro Max (paysage)'],
  ['1170x2532', 'iPhone 12/13/14'],
  ['2532x1170', 'iPhone 12/13/14 (paysage)'],
  ['1284x2778', 'iPhone 12/13 Pro Max, 14 Plus'],
  ['2778x1284', 'iPhone 12/13 Pro Max, 14 Plus (paysage)'],
  ['1125x2436', 'iPhone X/XS/11 Pro'],
  ['2436x1125', 'iPhone X/XS/11 Pro (paysage)'],
  ['1242x2688', 'iPhone XS Max / 11 Pro Max'],
  ['2688x1242', 'iPhone XS Max / 11 Pro Max (paysage)'],
  ['1080x2340', 'iPhone 12/13 mini'],
  ['2340x1080', 'iPhone 12/13 mini (paysage)'],
  ['828x1792', 'iPhone XR / 11'],
  ['1792x828', 'iPhone XR / 11 (paysage)'],
  ['750x1334', 'iPhone SE 2/3, 6/7/8'],
  ['1334x750', 'iPhone SE 2/3, 6/7/8 (paysage)'],
  ['1242x2208', 'iPhone 6/7/8 Plus'],
  ['2208x1242', 'iPhone 6/7/8 Plus (paysage)'],
  ['820x1180', 'iPad Air 10.9"'],
  ['1180x820', 'iPad Air 10.9" (paysage)'],
  ['2048x2732', 'iPad Pro 12.9"'],
  ['2732x2048', 'iPad Pro 12.9" (paysage)'],
];
const LOGO_PX = 168;
const GAP_PX = 32;
const NAME_PX = 56;
// Logo sombre à play teal (couleurs codées : les PNG n'héritent pas des
// variables CSS). #101823 = surface navy de la marque ; play = teal accent.
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="5" fill="#101823" stroke="#2a3138" stroke-width="0.5"/><path d="M9 7.5v9l7.5-4.5L9 7.5Z" fill="#8ee8cf"/></svg>`;
const logo = await sharp(Buffer.from(logoSvg)).resize(LOGO_PX, LOGO_PX).png().toBuffer();
const splashDir = join(pub, 'splash');
(await import('node:fs/promises')).mkdir(splashDir, { recursive: true });
for (const [size, label] of SPLASHES) {
  const [width, height] = size.split('x').map(Number);
  const file = join(splashDir, `${size}.png`);
  // Ensemble centré (logo + espacement + nom) comme le splash natif iOS.
  const groupHeight = LOGO_PX + GAP_PX + NAME_PX;
  const top = Math.round((height - groupHeight) / 2);
  const nameSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${NAME_PX}"><text x="${width / 2}" y="${NAME_PX * 0.76}" text-anchor="middle" font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif" font-size="${NAME_PX}" font-weight="800" letter-spacing="1" fill="#f5f7fa">Mbolo TV</text></svg>`;
  const name = await sharp(Buffer.from(nameSvg)).png().toBuffer();
  await sharp({ create: { width, height, channels: 4, background: '#101823' } })
    .composite([
      { input: logo, left: Math.round((width - LOGO_PX) / 2), top },
      { input: name, left: 0, top: top + LOGO_PX + GAP_PX },
    ])
    .png()
    .toFile(file);
  console.log('splash', size, '—', label);
}
console.log('Assets PWA générés dans', pub);
