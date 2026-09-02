'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiDelete, apiPut } from '../api/client';
import { sharedQueryClient } from '../components/QueryProvider';

// Miroir de favorites.ts pour le VOD : clés « vod:{id} » (jamais mélangées aux
// favoris chaînes), même logique optimiste + synchronisation serveur.
interface VodFavoritesState {
  ids: string[];
  /** true après la première synchronisation serveur réussie. */
  synced: boolean;
  toggle: (vodItemId: string) => void;
  has: (vodItemId: string) => boolean;
  syncFromServer: (serverIds: string[]) => void;
}

function invalidateVodFavorites(): void {
  void sharedQueryClient?.invalidateQueries({ queryKey: ['vod-favorites'] });
}

export const useVodFavoritesStore = create<VodFavoritesState>()(
  persist(
    (set, get) => ({
      ids: [],
      synced: false,
      toggle: (vodItemId) => {
        const previous = get().ids;
        const adding = !previous.includes(vodItemId);
        // Optimiste : l'UI réagit instantanément, le serveur confirme en
        // tâche de fond ; en cas d'échec on revient à l'état d'avant.
        set({ ids: adding ? [...previous, vodItemId] : previous.filter((id) => id !== vodItemId) });
        const call = adding ? apiPut(`/vod/${vodItemId}/favorite`) : apiDelete(`/vod/${vodItemId}/favorite`);
        void call.then(invalidateVodFavorites).catch(() => {
          set({ ids: previous });
          invalidateVodFavorites();
        });
      },
      has: (vodItemId) => get().ids.includes(vodItemId),
      syncFromServer: (serverIds) => {
        const local = get().ids;
        if (!get().synced) {
          const missing = local.filter((id) => !serverIds.includes(id));
          missing.forEach((id) => void apiPut(`/vod/${id}/favorite`).catch(() => undefined));
          set({ ids: [...serverIds, ...missing], synced: true });
          return;
        }
        set({ ids: serverIds });
      },
    }),
    { name: 'mbolo-vod-favorites' },
  ),
);
