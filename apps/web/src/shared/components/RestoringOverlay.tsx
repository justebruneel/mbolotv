'use client';

import { useIsRestoring } from '@tanstack/react-query';
import { Logo } from '@mbolo/ui';

export function RestoringOverlay() {
  const isRestoring = useIsRestoring();

  if (!isRestoring) return null;

  return (
    <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-bg">
      <Logo stacked size={84} />
      <div className="mt-6 h-1 w-16 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full w-full animate-shimmer rounded-full bg-accent" />
      </div>
    </div>
  );
}