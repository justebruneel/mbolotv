'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Favoris YouTube (onglet Nollywood) : 100 % locaux, JAMAIS synchronisés au
// serveur — les favoris VOD serveur ont une clé étrangère vers VodItem et
// rejetteraient les ids « yt:<videoId> » (ce qui annulerait le toggle
// optimiste). Clés « yt:<videoId> », jamais mélangées aux favoris chaînes.
interface YoutubeFavoritesState {
  ids: string[];
  toggle: (youtubeId: string) => void;
  has: (youtubeId: string) => boolean;
}

export const useYoutubeFavoritesStore = create<YoutubeFavoritesState>()(
  persist(
    (set, get) => ({
      ids: [],
      toggle: (youtubeId) => {
        const previous = get().ids;
        set({
          ids: previous.includes(youtubeId)
            ? previous.filter((id) => id !== youtubeId)
            : [...previous, youtubeId],
        });
      },
      has: (youtubeId) => get().ids.includes(youtubeId),
    }),
    { name: 'mbolo-youtube-favorites' },
  ),
);

/** Id de progression/favori pour une vidéo YouTube (cohabite avec les ids VodItem). */
export function youtubeProgressId(videoId: string): string {
  return `yt:${videoId}`;
}
