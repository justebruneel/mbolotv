'use client';

import { AppShell, Logo } from '@mbolo/ui';
import { usePathname } from 'next/navigation';
import { ReactNode } from 'react';
import { QueryProvider } from '../../shared/components/QueryProvider';

const NAV_ITEMS = [
  { href: '/live', label: 'Live TV', icon: '📡' },
  { href: '/epg', label: 'Guide TV', icon: '📺' },
  { href: '/matches', label: 'Matches', icon: '⚽' },
  { href: '/favorites', label: 'Favoris', icon: '♥' },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const active = NAV_ITEMS.find((item) => pathname?.startsWith(item.href))?.href;

  return (
    <QueryProvider>
      <AppShell brand={<Logo />} navItems={NAV_ITEMS} activeHref={active}>
        {children}
      </AppShell>
    </QueryProvider>
  );
}
