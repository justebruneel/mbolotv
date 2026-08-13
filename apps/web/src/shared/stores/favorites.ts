'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface FavoritesState {
  ids: string[];
  toggle: (channelId: string) => void;
  has: (channelId: string) => boolean;
}

export const useFavoritesStore = create<FavoritesState>()(
  persist(
    (set, get) => ({
      ids: [],
      toggle: (channelId) =>
        set((state) => ({
          ids: state.ids.includes(channelId)
            ? state.ids.filter((id) => id !== channelId)
            : [...state.ids, channelId],
        })),
      has: (channelId) => get().ids.includes(channelId),
    }),
    { name: 'mbolo-favorites' },
  ),
);
