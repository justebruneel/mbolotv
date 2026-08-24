'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function AutoRefresh({ enabled, interval = 2000 }: { enabled: boolean; interval?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => router.refresh(), interval);
    return () => window.clearInterval(id);
  }, [enabled, interval, router]);
  return null;
}
