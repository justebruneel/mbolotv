'use client';

import { AppShell, Icon, Logo } from '@mbolo/ui';
import { usePathname } from 'next/navigation';
import { ReactNode } from 'react';
import { QueryProvider } from '../../shared/components/QueryProvider';

const NAV_ITEMS = [
  { href: '/live', label: 'Live TV', icon: <Icon.Tv size={20} /> },
  { href: '/epg', label: 'Guide TV', icon: <Icon.CalendarDays size={20} /> },
  { href: '/matches', label: 'Matches', icon: <Icon.Trophy size={20} /> },
  { href: '/favorites', label: 'Favoris', icon: <Icon.Heart size={20} /> },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const active = NAV_ITEMS.find((item) => pathname?.startsWith(item.href))?.href;

  return (
    <QueryProvider>
      <AppShell brand={<Logo />} navItems={NAV_ITEMS} activeHref={active} pathname={pathname}>
        {children}
      </AppShell>
    </QueryProvider>
  );
}
