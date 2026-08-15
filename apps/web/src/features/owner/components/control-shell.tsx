'use client';

import { AppShell, Logo } from '@mbolo/ui';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { IconAudit, IconImports, IconOverview, IconSources } from './ui/icons';

const NAV = [
  { href: '/control', label: 'Vue d’ensemble', icon: <IconOverview className="h-[18px] w-[18px]" /> },
  { href: '/control/sources', label: 'Sources', icon: <IconSources className="h-[18px] w-[18px]" /> },
  { href: '/control/imports', label: 'Imports', icon: <IconImports className="h-[18px] w-[18px]" /> },
  { href: '/control/audit', label: 'Audit', icon: <IconAudit className="h-[18px] w-[18px]" /> },
];

export function ControlShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const active = NAV.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))?.href;

  return (
    <AppShell brand={<Logo size={26} />} navItems={NAV} activeHref={active} pathname={pathname}>
      {children}
    </AppShell>
  );
}
