'use client';

import { Icon } from '@mbolo/ui';

// Bouton « Réessayer » des états d'erreur (catalogue indisponible), même
// gabarit que la page Favoris.
export function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 rounded-full border border-accent bg-accent px-3.5 py-1.5 text-xs font-bold text-on-accent">
      <Icon.RefreshCw size={14} />
      Réessayer
    </button>
  );
}