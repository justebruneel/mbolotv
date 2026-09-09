import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@mbolo/ui/src/tokens.css';
import './globals.css';
import '../styles/pwa.css';
import { PwaRegister } from '../shared/components/PwaRegister';
import { OfflineOverlay } from '../shared/components/OfflineOverlay';

export const metadata: Metadata = {
  title: { default: 'Mbolo TV', template: '%s · Mbolo TV' },
  description: 'Regardez vos chaînes en direct, avec une lecture fluide et adaptative.',
  applicationName: 'Mbolo TV',
  manifest: '/manifest.webmanifest',
  // apple-touch-icon : PNG obligatoire (Safari ignore le SVG — sans PNG,
  // l'écran d'accueil iOS affiche une capture de la page).
  icons: { icon: '/icon.svg', shortcut: '/icon.svg', apple: '/apple-icon.png' },
  // PWA iOS : plein écran immersif, contenu sous la barre de statut
  // (les safe-areas env() sont déjà gérées par l'AppShell et le body).
  appleWebApp: { capable: true, title: 'Mbolo TV', statusBarStyle: 'black-translucent' },
};

// Splash de lancement iOS (apple-touch-startup-image) : iOS exige la taille
// EXACTE de chaque appareil — sans elles, le lancement PWA affiche la fenêtre
// brute (noir/theme-color) pendant tout le chargement. Générées par
// scripts/generate-pwa-assets.mjs. Fond unique #101823 aligné sur le
// theme-color : le splash se confond avec la fenêtre, seul le logo apparaît.
const IOS_SPLASHES: Array<{ size: string; width: string; height: string; dpr: string; orientation: 'portrait' | 'landscape' }> = [
  // iPhone 15/16 — 393x852 dpr3
  { size: '1179x2556', width: '393', height: '852', dpr: '3', orientation: 'portrait' },
  { size: '2556x1179', width: '393', height: '852', dpr: '3', orientation: 'landscape' },
  // iPhone 15/16 Pro Max — 430x932 dpr3
  { size: '1290x2796', width: '430', height: '932', dpr: '3', orientation: 'portrait' },
  { size: '2796x1290', width: '430', height: '932', dpr: '3', orientation: 'landscape' },
  // iPhone 12/13/14 — 390x844 dpr3
  { size: '1170x2532', width: '390', height: '844', dpr: '3', orientation: 'portrait' },
  { size: '2532x1170', width: '390', height: '844', dpr: '3', orientation: 'landscape' },
  // iPhone 12/13 Pro Max, 14 Plus — 428x926 dpr3
  { size: '1284x2778', width: '428', height: '926', dpr: '3', orientation: 'portrait' },
  { size: '2778x1284', width: '428', height: '926', dpr: '3', orientation: 'landscape' },
  // iPhone X/XS/11 Pro — 375x812 dpr3
  { size: '1125x2436', width: '375', height: '812', dpr: '3', orientation: 'portrait' },
  { size: '2436x1125', width: '375', height: '812', dpr: '3', orientation: 'landscape' },
  // iPhone XS Max / 11 Pro Max — 414x896 dpr3
  { size: '1242x2688', width: '414', height: '896', dpr: '3', orientation: 'portrait' },
  { size: '2688x1242', width: '414', height: '896', dpr: '3', orientation: 'landscape' },
  // iPhone 12/13 mini — 360x780 dpr3
  { size: '1080x2340', width: '360', height: '780', dpr: '3', orientation: 'portrait' },
  { size: '2340x1080', width: '360', height: '780', dpr: '3', orientation: 'landscape' },
  // iPhone XR / 11 — 414x896 dpr2
  { size: '828x1792', width: '414', height: '896', dpr: '2', orientation: 'portrait' },
  { size: '1792x828', width: '414', height: '896', dpr: '2', orientation: 'landscape' },
  // iPhone SE 2/3, 6/7/8 — 375x667 dpr2
  { size: '750x1334', width: '375', height: '667', dpr: '2', orientation: 'portrait' },
  { size: '1334x750', width: '375', height: '667', dpr: '2', orientation: 'landscape' },
  // iPhone 6/7/8 Plus — 414x736 dpr3
  { size: '1242x2208', width: '414', height: '736', dpr: '3', orientation: 'portrait' },
  { size: '2208x1242', width: '414', height: '736', dpr: '3', orientation: 'landscape' },
  // iPad Air 10.9" — 820x1180 dpr2
  { size: '820x1180', width: '820', height: '1180', dpr: '2', orientation: 'portrait' },
  { size: '1180x820', width: '820', height: '1180', dpr: '2', orientation: 'landscape' },
  // iPad Pro 12.9" — 1024x1366 dpr2
  { size: '2048x2732', width: '1024', height: '1366', dpr: '2', orientation: 'portrait' },
  { size: '2732x2048', width: '1024', height: '1366', dpr: '2', orientation: 'landscape' },
];
// Zoom pinceau et double-tap désactivés : l'app doit garder sa forme native.
// theme-color UNIQUE = #101823, la même couleur que le fond du splash iOS et
// que le fond de l'app (--mbolo-bg) : la fenêtre affichée par iOS avant et
// pendant le splash est donc invisible — le logo apparaît directement.
export const viewport: Viewport = { themeColor: '#101823', width: 'device-width', initialScale: 1, maximumScale: 1, userScalable: false, viewportFit: 'cover' };

// Thème unique sombre : data-theme posé d'office (le script legacy qui
// lisait « mbolo-theme » disparaît — la clé est purgée des anciens clients).
const THEME_INIT_SCRIPT = `
(function() {
  try {
    localStorage.removeItem('mbolo-theme');
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.classList.add('dark');
  } catch(e) {}
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr" suppressHydrationWarning style={{ backgroundColor: '#101823' }}>
      <head>
        {/* Fond posé dès la première frame (avant tout CSS) : identique au
            splash iOS et au fond de l'app — aucune transition sombre visible. */}
        <style>{'html{background-color:#101823}'}</style>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {IOS_SPLASHES.map((splash) => (
          <link
            key={splash.size}
            rel="apple-touch-startup-image"
            href={`/splash/${splash.size}.png`}
            media={`(device-width: ${splash.width}px) and (device-height: ${splash.height}px) and (-webkit-device-pixel-ratio: ${splash.dpr}) and (orientation: ${splash.orientation})`}
          />
        ))}
      </head>
      <body>
        <a href="#main-content" className="skip-link">
          Aller au contenu principal
        </a>
        <PwaRegister />
        <OfflineOverlay />
        {children}
      </body>
    </html>
  );
}
