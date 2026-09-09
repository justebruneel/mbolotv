'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Favoris YouTube (onglet Nollywood) : 100 % locaux, JAMAIS synchronisés au
// serveur — les favoris VOD serveur ont une clé étrangère vers VodItem et
// rejetteraient les ids « yt:<videoId> » (ce qui annulerait le toggle
// optimiste). Clés « yt:<videoId> », jamais mélangées aux favoris chaînes.
export interface YoutubeFavoriteEntry {
  /** videoId brut (sans préfixe yt:). */
  id: string;
  title: string;
  posterUrl: string | null;
  addedAt: string;
}

export interface YoutubeFavoriteMeta {
  title: string;
  posterUrl: string | null;
}

interface YoutubeFavoritesState {
  ids: string[];
  entries: YoutubeFavoriteEntry[];
  toggle: (youtubeId: string) => void;
  /** Toggle avec métadonnées : la voie des fiches — l'entrée d'affichage
   * accompagne l'id (la page Favoris rend les tuiles sans fetch). */
  toggleWithMeta: (youtubeId: string, meta: YoutubeFavoriteMeta) => void;
  /** Retrait direct (corbeille de la page Favoris), id préfixé « yt: ». */
  remove: (youtubeId: string) => void;
  has: (youtubeId: string) => boolean;
}

export const useYoutubeFavoritesStore = create<YoutubeFavoritesState>()(
  persist(
    (set, get) => ({
      ids: [],
      entries: [],
      toggle: (youtubeId) => {
        const previous = get().ids;
        set({
          ids: previous.includes(youtubeId)
            ? previous.filter((id) => id !== youtubeId)
            : [...previous, youtubeId],
        });
      },
      toggleWithMeta: (youtubeId, meta) => {
        const rawId = stripYoutubePrefix(youtubeId);
        const previous = get().ids;
        const previousEntries = get().entries;
        if (previous.includes(youtubeId)) {
          set({
            ids: previous.filter((id) => id !== youtubeId),
            entries: previousEntries.filter((entry) => entry.id !== rawId),
          });
          return;
        }
        set({
          ids: [...previous, youtubeId],
          entries: [
            ...previousEntries,
            { id: rawId, ...meta, addedAt: new Date().toISOString() },
          ],
        });
      },
      has: (youtubeId) => get().ids.includes(youtubeId),
      remove: (youtubeId) => {
        // ids préfixés (« yt:<id> »), entrées en id brut : la comparaison
        // passe par la forme brute pour nettoyer les deux espaces ensemble.
        const target = stripYoutubePrefix(youtubeId);
        set({
          ids: get().ids.filter((id) => stripYoutubePrefix(id) !== target),
          entries: get().entries.filter((entry) => stripYoutubePrefix(entry.id) !== target),
        });
      },
    }),
    {
      name: 'mbolo-youtube-favorites',
      version: 1,
      // v1 : les entrées portaient l'id PRÉFIXÉ (« yt:<id> ») au lieu de
      // l'id brut — les tuiles Nollywood renvoyaient vers /vod/yt/yt:<id>
      // (« Contenu introuvable »). Migration : purge du préfixe.
      migrate: (persisted) => {
        const state = persisted as Partial<YoutubeFavoritesState> | undefined;
        return {
          ids: state?.ids ?? [],
          entries: (state?.entries ?? []).map((entry) => ({ ...entry, id: stripYoutubePrefix(entry.id) })),
        } as Partial<YoutubeFavoritesState>;
      },
    },
  ),
);

/** Normalise un identifiant YouTube : retire le préfixe « yt: » s'il existe. */
function stripYoutubePrefix(id: string): string {
  return id.startsWith('yt:') ? id.slice(3) : id;
}

/** Id de progression/favori pour une vidéo YouTube (cohabite avec les ids VodItem). */
export function youtubeProgressId(videoId: string): string {
  return `yt:${videoId}`;
}
