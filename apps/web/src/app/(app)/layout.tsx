'use client';

import { AppShell, Icon, Logo } from '@mbolo/ui';
import { usePathname } from 'next/navigation';
import { ReactNode } from 'react';
import { QueryProvider } from '../../shared/components/QueryProvider';

const NAV_ITEMS = [
  { href: '/live', label: 'Live TV', icon: <Icon.Tv size={20} /> },
  { href: '/favorites', label: 'Favoris', icon: <Icon.Heart size={20} /> },
];
const UTILITY_ITEMS = [
  { href: '/docs', label: 'Documentation', icon: <Icon.BookOpen size={17} /> },
  { href: '/about', label: 'À propos', icon: <Icon.Info size={17} /> },
  { href: '/help', label: 'Centre d’aide', icon: <Icon.CircleHelp size={17} /> },
  { href: '/contact', label: 'Contact', icon: <Icon.Mail size={17} /> },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const active = NAV_ITEMS.find((item) => pathname?.startsWith(item.href))?.href;
  return <QueryProvider><AppShell brand={<Logo />} navItems={NAV_ITEMS} utilityItems={UTILITY_ITEMS} activeHref={active} pathname={pathname}>{children}</AppShell></QueryProvider>;
}
