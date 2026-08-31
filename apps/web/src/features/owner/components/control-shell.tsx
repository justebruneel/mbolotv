'use client';

import { AppShell, Logo } from '@mbolo/ui';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { IconAudit, IconBell, IconImports, IconKey, IconLayers, IconOverview, IconSources, IconUsers } from './ui/icons';

const OWNER_PATH_KEY = 'mbolo:owner-path';

export function ControlShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const pathSegments = pathname.split('/');
  const ADMIN_SECTIONS = ['sources', 'imports', 'audit'];
  const isOwnerConsole = pathSegments[1] === 'control' && pathSegments[2] !== undefined && !ADMIN_SECTIONS.includes(pathSegments[2]);

  // Le chemin secret owner est mémorisé à chaque visite de la console : depuis
  // les pages admin (/control/sources…) le segment dynamique est inconnu de
  // l'URL, mais la navigation complète reste reconstruisible via cette
  // mémoire — sinon Catalogue, Codes d'accès, Profil et Notifications
  // disparaissent des menus dès qu'on quitte la console owner.
  const [rememberedPath, setRememberedPath] = useState<string | null>(null);
  useEffect(() => {
    if (isOwnerConsole && pathSegments[2]) {
      try { window.localStorage.setItem(OWNER_PATH_KEY, pathSegments[2]); } catch { /* stockage indisponible */ }
      return;
    }
    try { setRememberedPath(window.localStorage.getItem(OWNER_PATH_KEY)); } catch { setRememberedPath(null); }
  }, [isOwnerConsole, pathname]);

  const ownerBase = isOwnerConsole ? `/control/${pathSegments[2]}` : rememberedPath ? `/control/${rememberedPath}` : null;

  // Sans chemin owner connu (première visite directe en admin), les entrées
  // owner-scopées pointeraient sur le segment dynamique [ownerPath]
  // (aperçu fantôme) : on ne les affiche que si le chemin est résolu.
  const adminNav = [
    { href: '/control/sources', label: 'Sources', icon: <IconSources className="h-[18px] w-[18px]" /> },
    { href: '/control/imports', label: 'Imports', icon: <IconImports className="h-[18px] w-[18px]" /> },
    { href: '/control/audit', label: 'Audit', icon: <IconAudit className="h-[18px] w-[18px]" /> },
  ];
  const NAV = ownerBase
    ? [
        { href: ownerBase, label: 'Vue d’ensemble', icon: <IconOverview className="h-[18px] w-[18px]" /> },
        { href: `${ownerBase}/catalog`, label: 'Catalogue public', icon: <IconLayers className="h-[18px] w-[18px]" /> },
        { href: `${ownerBase}/access`, label: 'Codes d’accès', icon: <IconKey className="h-[18px] w-[18px]" /> },
        { href: `${ownerBase}/profile`, label: 'Profil', icon: <IconUsers className="h-[18px] w-[18px]" /> },
        { href: `${ownerBase}/notifications`, label: 'Notifications', icon: <IconBell className="h-[18px] w-[18px]" /> },
        ...adminNav,
      ]
    : [{ href: '/control', label: 'Vue d’ensemble', icon: <IconOverview className="h-[18px] w-[18px]" /> }, ...adminNav];

  // Exact d'abord, préfixe ensuite : sinon « Vue d'ensemble » (/control)
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
