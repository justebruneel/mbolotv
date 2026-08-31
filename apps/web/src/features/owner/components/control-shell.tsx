'use client';

import { AppShell, Logo } from '@mbolo/ui';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { IconAudit, IconBell, IconImports, IconKey, IconLayers, IconOverview, IconSources, IconUsers } from './ui/icons';

export function ControlShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const pathSegments = pathname.split('/');
  const ADMIN_SECTIONS = ['sources', 'imports', 'audit'];
  const isOwnerConsole = pathSegments[1] === 'control' && pathSegments[2] !== undefined && !ADMIN_SECTIONS.includes(pathSegments[2]);
  const base = isOwnerConsole ? `/control/${pathSegments[2]}` : '/control';

  const NAV = [
    { href: base, label: 'Vue d’ensemble', icon: <IconOverview className="h-[18px] w-[18px]" /> },
    { href: `${base}/catalog`, label: 'Catalogue public', icon: <IconLayers className="h-[18px] w-[18px]" /> },
  { href: `${base}/access`, label: 'Codes d’accès', icon: <IconKey className="h-[18px] w-[18px]" /> },
  { href: `${base}/profile`, label: 'Profil', icon: <IconUsers className="h-[18px] w-[18px]" /> },
  { href: `${base}/notifications`, label: 'Notifications', icon: <IconBell className="h-[18px] w-[18px]" /> },
  { href: '/control/sources', label: 'Sources', icon: <IconSources className="h-[18px] w-[18px]" /> },
    { href: '/control/imports', label: 'Imports', icon: <IconImports className="h-[18px] w-[18px]" /> },
    { href: '/control/audit', label: 'Audit', icon: <IconAudit className="h-[18px] w-[18px]" /> },
  ];

  const active = NAV.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))?.href;

  return (
    <AppShell brand={<Logo size={26} />} navItems={NAV} activeHref={active} pathname={pathname}>
      {/* Console = outil de travail : le texte doit rester copiable malgré le
          comportement natif (user-select: none) appliqué au reste de l'app. */}
      <div className="console-selectable">{children}</div>
    </AppShell>
  );
}
