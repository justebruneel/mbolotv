'use client';

import { AppShell, Icon, Logo } from '@mbolo/ui';
import { usePathname } from 'next/navigation';
import { ReactNode } from 'react';
import { QueryProvider } from '../../shared/components/QueryProvider';
import { RouteTracker } from '../../shared/components/RouteTracker';
import { ThemeToggle } from '../../shared/components/ThemeToggle';
import { useActiveUsers, useActivityHeartbeat } from '../../shared/api/queries';

const NAV_ITEMS = [
  { href: '/live', label: 'Live TV', icon: <Icon.Tv size={20} /> },
  { href: '/favorites', label: 'Favoris', icon: <Icon.Heart size={20} /> },
];
const UTILITY_ITEMS = [
  { href: '/docs', label: 'Documentation', icon: <Icon.BookOpen size={17} /> },
  { href: '/about', label: 'À propos', icon: <Icon.Info size={17} /> },
  { href: '/help', label: "Centre d'aide", icon: <Icon.CircleHelp size={17} /> },
  { href: '/contact', label: 'Contact', icon: <Icon.Mail size={17} /> },
];

function ShellContent({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const active = NAV_ITEMS.find((item) => pathname?.startsWith(item.href))?.href;
  const { data: activeData } = useActiveUsers();
  useActivityHeartbeat();

  return (
    <>
    <RouteTracker />
    <AppShell
      brand={<Logo />}
      navItems={NAV_ITEMS}
      utilityItems={UTILITY_ITEMS}
      sidebarActions={<ThemeToggle />}
      activeHref={active}
      pathname={pathname}
      activeUsers={activeData?.global}
    >
      {children}
    </AppShell>
    </>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <ShellContent>{children}</ShellContent>
    </QueryProvider>
  );
}
