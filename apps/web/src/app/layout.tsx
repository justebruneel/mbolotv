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
  icons: { icon: '/icon.svg', shortcut: '/icon.svg', apple: '/apple-icon.svg' },
  // PWA iOS : plein écran immersif, contenu sous la barre de statut
  // (les safe-areas env() sont déjà gérées par l'AppShell et le body).
  appleWebApp: { capable: true, title: 'Mbolo TV', statusBarStyle: 'black-translucent' },
};
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
