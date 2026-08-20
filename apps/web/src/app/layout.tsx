import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@mbolo/ui/src/tokens.css';
import './globals.css';
import '../styles/pwa.css';

export const metadata: Metadata = {
  title: { default: 'Mbolo TV', template: '%s · Mbolo TV' },
  description: 'Regardez vos chaînes en direct, avec une lecture fluide et adaptative.',
  applicationName: 'Mbolo TV',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', shortcut: '/icon.svg', apple: '/apple-icon.svg' },
};
export const viewport: Viewport = { themeColor: '#101823', width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="fr"><body>{children}</body></html>; }
