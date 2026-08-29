'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settings';

/**
 * Nombre de navigations client-side depuis le chargement du document.
 * Module-scoped (non persisté) : permet de distinguer « l'utilisateur a
 * navigué dans l'app » (retour historique sûr) d'une entrée directe sur
 * une page (fallback vers lastNonWatchPath).
 */
export const internalNavigationCount: { value: number } = { value: 0 };

export function RouteTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const setLastNonWatchPath = useSettingsStore((s) => s.setLastNonWatchPath);
  const prevPathname = useRef(pathname);

  useEffect(() => {
    if (prevPathname.current !== pathname) internalNavigationCount.value += 1;
    if (pathname && !pathname.startsWith('/watch')) {
      const search = searchParams.toString();
      setLastNonWatchPath(search ? `${pathname}?${search}` : pathname);
    }
    prevPathname.current = pathname;
  }, [pathname, searchParams, setLastNonWatchPath]);

  return null;
}
