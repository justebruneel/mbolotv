import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@mbolo/ui/src/tokens.css';
import './globals.css';
import '../styles/pwa.css';
import { PwaRegister } from '../shared/components/PwaRegister';

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
// EXACTE de chaque appareil — sans elles, le lancement PWA flashe en blanc
// avant le premier rendu. Générées par scripts/generate-pwa-assets.mjs.
const IOS_SPLASHES: Array<{ size: string; width: string; height: string; dpr: string; orientation: 'portrait' | 'landscape' }> = [
  { size: '1290x2796', width: '430', height: '932', dpr: '3', orientation: 'portrait' },
  { size: '2796x1290', width: '430', height: '932', dpr: '3', orientation: 'landscape' },
  { size: '1179x2556', width: '393', height: '852', dpr: '3', orientation: 'portrait' },
  { size: '2556x1179', width: '393', height: '852', dpr: '3', orientation: 'landscape' },
  { size: '1284x2778', width: '428', height: '926', dpr: '3', orientation: 'portrait' },
  { size: '2778x1284', width: '428', height: '926', dpr: '3', orientation: 'landscape' },
  { size: '1170x2532', width: '390', height: '844', dpr: '3', orientation: 'portrait' },
  { size: '2532x1170', width: '390', height: '844', dpr: '3', orientation: 'landscape' },
  { size: '820x1180', width: '820', height: '1180', dpr: '2', orientation: 'portrait' },
  { size: '1180x820', width: '820', height: '1180', dpr: '2', orientation: 'landscape' },
  { size: '2048x2732', width: '1024', height: '1366', dpr: '2', orientation: 'portrait' },
  { size: '2732x2048', width: '1024', height: '1366', dpr: '2', orientation: 'landscape' },
];
// Zoom pinceau et double-tap désactivés : l'app doit garder sa forme native.
// Thème unique sombre : un seul theme-color, plus de variante claire.
export const viewport: Viewport = { themeColor: '#0f1419', width: 'device-width', initialScale: 1, maximumScale: 1, userScalable: false, viewportFit: 'cover' };

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
    <html lang="fr" suppressHydrationWarning>
      <head>
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
        {children}
      </body>
    </html>
  );
}
