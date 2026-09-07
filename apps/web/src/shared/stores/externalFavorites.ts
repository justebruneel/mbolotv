'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Favoris de titres externes (onglet Films, /vod/x) : 100 % locaux, JAMAIS
// synchronisés au serveur — même motif que youtubeFavorites.ts : les favoris
// VOD serveur ont une clé étrangère vers VodItem et rejetteraient les ids
// « x:<titleId> ». Clés préfixées, jamais mélangées aux autres espaces.
interface ExternalFavoritesState {
  ids: string[];
  toggle: (externalId: string) => void;
  has: (externalId: string) => boolean;
}

export const useExternalFavoritesStore = create<ExternalFavoritesState>()(
  persist(
    (set, get) => ({
      ids: [],
      toggle: (externalId) => {
        const previous = get().ids;
        set({
          ids: previous.includes(externalId)
            ? previous.filter((id) => id !== externalId)
            : [...previous, externalId],
        });
      },
      has: (externalId) => get().ids.includes(externalId),
    }),
    { name: 'mbolo-external-favorites' },
  ),
);

/** Id de favori pour un titre externe (cohabite avec les autres espaces d'ids). */
export function externalFavoriteId(titleId: string): string {
  return `x:${titleId}`;
}
