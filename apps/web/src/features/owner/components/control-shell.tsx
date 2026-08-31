'use client';

import { AppShell, Logo } from '@mbolo/ui';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { IconAudit, IconBell, IconImports, IconKey, IconLayers, IconOverview, IconSources, IconUsers } from './ui/icons';

export function ControlShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';

  // Le segment dynamique [ownerPath] est décoratif : l'authentification passe
  // par le cookie de session et ownerApi ne construit jamais d'URL avec lui.
  // La base de navigation est donc FIXE (/control/me) — les liens owner
  // (Catalogue public, Codes d'accès, Profil, Notifications) restent
  // construits et cliquables depuis n'importe quelle page, admin incluse.
  const ownerBase = '/control/me';

  const adminNav = [
    { href: '/control/sources', label: 'Sources', icon: <IconSources className="h-[18px] w-[18px]" /> },
    { href: '/control/imports', label: 'Imports', icon: <IconImports className="h-[18px] w-[18px]" /> },
    { href: '/control/audit', label: 'Audit', icon: <IconAudit className="h-[18px] w-[18px]" /> },
  ];
  const NAV = [
    { href: ownerBase, label: 'Vue d’ensemble', icon: <IconOverview className="h-[18px] w-[18px]" /> },
    { href: `${ownerBase}/catalog`, label: 'Catalogue public', icon: <IconLayers className="h-[18px] w-[18px]" /> },
    { href: `${ownerBase}/access`, label: 'Codes d’accès', icon: <IconKey className="h-[18px] w-[18px]" /> },
    { href: `${ownerBase}/profile`, label: 'Profil', icon: <IconUsers className="h-[18px] w-[18px]" /> },
    { href: `${ownerBase}/notifications`, label: 'Notifications', icon: <IconBell className="h-[18px] w-[18px]" /> },
    ...adminNav,
  ];

  // Exact d'abord, préfixe ensuite : sinon « Vue d'ensemble » (/control/me)
  // resterait surligné sur toutes les pages admin.
  const active = (NAV.find((item) => pathname === item.href) ?? NAV.find((item) => pathname.startsWith(`${item.href}/`)))?.href;

  return (
    <AppShell brand={<Logo size={26} />} navItems={NAV} activeHref={active} pathname={pathname}>
      {/* Console = outil de travail : le texte doit rester copiable malgré le
          comportement natif (user-select: none) appliqué au reste de l'app. */}
      <div className="console-selectable">{children}</div>
    </AppShell>
  );
}
