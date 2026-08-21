'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settings';

export function RouteTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const setLastNonWatchPath = useSettingsStore((s) => s.setLastNonWatchPath);
  const prevPathname = useRef(pathname);

  useEffect(() => {
    if (pathname && !pathname.startsWith('/watch')) {
      const search = searchParams.toString();
      setLastNonWatchPath(search ? `${pathname}?${search}` : pathname);
    }
    prevPathname.current = pathname;
  }, [pathname, searchParams, setLastNonWatchPath]);

  return null;
}
