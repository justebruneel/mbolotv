'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiDelete, apiPut } from '../api/client';
import { sharedQueryClient } from '../components/QueryProvider';

interface FavoritesState {
  ids: string[];
  /** true après la première synchronisation serveur réussie : ensuite le
   * serveur fait foi, sinon les retraits faits sur un autre appareil
   * ressusciteraient ici au chargement. */
  synced: boolean;
  toggle: (channelId: string) => void;
  has: (channelId: string) => boolean;
  /** Importe la liste serveur ; au premier passage, les favoris du
   * localStorage inconnus du serveur y sont poussés (migration), puis le
   * serveur devient la source de vérité de cet appareil. */
  syncFromServer: (serverIds: string[]) => void;
}

function invalidateFavorites(): void {
  void sharedQueryClient?.invalidateQueries({ queryKey: ['favorites'] });
}

export const useFavoritesStore = create<FavoritesState>()(
  persist(
    (set, get) => ({
      ids: [],
      synced: false,
      toggle: (channelId) => {
        const previous = get().ids;
        const adding = !previous.includes(channelId);
        // Optimiste : l'UI réagit instantanément, le serveur confirme en
        // tâche de fond ; en cas d'échec on revient à l'état d'avant.
        set({ ids: adding ? [...previous, channelId] : previous.filter((id) => id !== channelId) });
        const call = adding ? apiPut(`/favorites/${channelId}`) : apiDelete(`/favorites/${channelId}`);
        void call.then(invalidateFavorites).catch(() => {
          set({ ids: previous });
          invalidateFavorites();
        });
      },
      has: (channelId) => get().ids.includes(channelId),
      syncFromServer: (serverIds) => {
        const local = get().ids;
        if (!get().synced) {
          const missing = local.filter((id) => !serverIds.includes(id));
          missing.forEach((id) => void apiPut(`/favorites/${id}`).catch(() => undefined));
          set({ ids: [...serverIds, ...missing], synced: true });
          return;
        }
        set({ ids: serverIds });
      },
    }),
    { name: 'mbolo-favorites' },
  ),
);
