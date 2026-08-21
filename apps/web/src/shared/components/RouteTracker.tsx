'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settings';

export function RouteTracker() {
  const pathname = usePathname();
  const setLastNonWatchPath = useSettingsStore((s) => s.setLastNonWatchPath);
  const prevPathname = useRef(pathname);

  useEffect(() => {
    if (pathname && !pathname.startsWith('/watch')) {
      setLastNonWatchPath(pathname);
    }
    prevPathname.current = pathname;
  }, [pathname, setLastNonWatchPath]);

  return null;
}
