'use client';

import { Icon } from '@mbolo/ui';
import { useNetworkStatus } from '../hooks/useNetworkStatus';

/**
 * Écran hors ligne plein écran : tant que la connexion n'est pas rétablie,
 * un message centré occupe toute la fenêtre (plus de bannière rouge en haut
 * des pages). Il disparaît de lui-même au retour du réseau.
 */
export function OfflineOverlay() {
  const isOnline = useNetworkStatus();

  if (isOnline) {
    return null;
  }

  return (
    <div
      role="alert"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-hidden bg-bg px-6 text-center"
    >
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-accent/10 blur-[120px]" />
      <Icon.WifiOff size={48} aria-hidden className="text-muted" />
      <h1 className="mt-6 text-xl font-black tracking-tight">Vous êtes hors ligne</h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted">
        Vérifiez votre connexion Internet pour accéder à Mbolo TV.
      </p>
    </div>
  );
}