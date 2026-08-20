import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@mbolo/ui/src/tokens.css';
import './globals.css';
import '../styles/pwa.css';
import { PwaRegister } from '../shared/components/PwaRegister';
import { ThemeProvider } from '../shared/components/ThemeProvider';

export const metadata: Metadata = {
  title: { default: 'Mbolo TV', template: '%s · Mbolo TV' },
  description: 'Regardez vos chaînes en direct, avec une lecture fluide et adaptative.',
  applicationName: 'Mbolo TV',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', shortcut: '/icon.svg', apple: '/apple-icon.svg' },
};
export const viewport: Viewport = { themeColor: [{ color: '#0f1419', media: '(prefers-color-scheme: dark)' }, { color: '#f8f9fa', media: '(prefers-color-scheme: light)' }], width: 'device-width', initialScale: 1, viewportFit: 'cover' };

const THEME_INIT_SCRIPT = `
(function() {
  try {
    var t = localStorage.getItem('mbolo-theme');
    var d = window.matchMedia('(prefers-color-scheme: light)').matches;
    var theme = t || 'system';
    var resolved = theme === 'system' ? (d ? 'light' : 'dark') : theme;
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.classList.add(resolved);
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
        <ThemeProvider>
          <a href="#main-content" className="skip-link">
            Aller au contenu principal
          </a>
          <PwaRegister />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
