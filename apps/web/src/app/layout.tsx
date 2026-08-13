import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@mbolo/ui/src/tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mbolo TV',
  description: 'Plateforme IPTV multi-sources',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
