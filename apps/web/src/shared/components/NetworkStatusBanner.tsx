'use client';

import { useNetworkStatus } from '../hooks/useNetworkStatus';

/**
 * Bannière affichée lorsque l'utilisateur est hors ligne.
 * S'affiche en haut de l'écran et reste visible jusqu'à ce que la connexion soit rétablie.
 */
export function NetworkStatusBanner() {
  const isOnline = useNetworkStatus();

  if (isOnline) {
    return null;
  }

  return (
    <div
      role="alert"
      className="fixed top-0 left-0 right-0 z-50 bg-red-600 text-white px-4 py-3 text-center text-sm font-medium shadow-lg"
    >
      <p>Vous êtes hors ligne. Vérifiez votre connexion Internet.</p>
    </div>
  );
}