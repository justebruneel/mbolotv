'use client';

import { AppShell, Icon, Logo } from '@mbolo/ui';
import { usePathname } from 'next/navigation';
import { ReactNode, Suspense } from 'react';
import { QueryProvider } from '../../shared/components/QueryProvider';
import { RouteTracker } from '../../shared/components/RouteTracker';
import { GlobalPlayer } from '../../shared/components/GlobalPlayer';
import { useActiveUsers, useActivityHeartbeat, useFavoritesSync, useRemindersSync, useUnreadAnnouncements } from '../../shared/api/queries';
import { useReminderScheduler } from '../../features/epg/hooks/useReminderScheduler';
import { HeaderSearch } from '../../features/live-tv/components/HeaderSearch';
import { AccessGuard, AccessTimeBadge } from '../../features/auth/components/access';

const NAV_ITEMS = [
  { href: '/live', label: 'Live TV', icon: <Icon.Tv size={20} /> },
  { href: '/epg', label: 'Programmes', icon: <Icon.CalendarDays size={20} /> },
  { href: '/favorites', label: 'Favoris', icon: <Icon.Heart size={20} /> },
];
// Menu ⋮ / « Plus » : uniquement des pages internes (liens SPA). La navigation
// principale a déjà ses onglets ; l'aide se limite à Documentation + Contact.
function buildMenuSections(unreadWhatsNew: number) {
  return [
    {
      label: 'Compte',
      items: [
        { href: '/access', label: 'Mon accès', icon: <Icon.Key size={17} /> },
        { href: '/whats-new', label: 'Quoi de neuf', icon: <Icon.Bell size={17} />, badge: unreadWhatsNew },
      ],
    },
    {
      label: 'Application',
      items: [
        { href: '/preferences', label: 'Préférences', icon: <Icon.Settings2 size={17} /> },
        { href: '/docs', label: 'Documentation', icon: <Icon.BookOpen size={17} /> },
        { href: '/contact', label: 'Contact', icon: <Icon.Mail size={17} /> },
      ],
    },
  ];
}

function ShellContent({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const active = NAV_ITEMS.find((item) => pathname?.startsWith(item.href))?.href;
  const { data: activeData } = useActiveUsers();
  useActivityHeartbeat();
  // Favoris : synchronisation initiale avec la liste serveur de l'appareil.
  useFavoritesSync();
  // Rappels de programmes : miroir serveur + secours local quand l'app est ouverte.
  useRemindersSync();
  useReminderScheduler();
  // Pastille « Quoi de neuf » : annonces plus récentes que la dernière lecture.
  const unreadWhatsNew = useUnreadAnnouncements();

  return (
    <>
      <Suspense><RouteTracker /></Suspense>
      {/* Lecteur global : unique instance, survit aux navigations live/favoris */}
      <Suspense><GlobalPlayer /></Suspense>
      <AppShell
        brand={<Logo />}
        navItems={NAV_ITEMS}
        menuSections={buildMenuSections(unreadWhatsNew)}
        menuBadge={unreadWhatsNew}
        searchSlot={pathname?.startsWith('/live') ? (
          <div className="flex items-center gap-2">
            <Suspense fallback={<div className="h-10 w-10" />}>
              <HeaderSearch />
            </Suspense>
            <AccessTimeBadge />
          </div>
        ) : undefined}
        activeHref={active}
        pathname={pathname}
        activeUsers={activeData?.global}
      >
        <AccessGuard>{children}</AccessGuard>
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
