'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Favoris de titres externes (onglet Films, /vod/x) : 100 % locaux, JAMAIS
// synchronisés au serveur — même motif que youtubeFavorites.ts : les favoris
// VOD serveur ont une clé étrangère vers VodItem et rejetteraient les ids
// « x:<titleId> ». Clés préfixées, jamais mélangées aux autres espaces.
//
// `entries` porte les métadonnées d'affichage (titre, affiche, type, année)
// capturées au moment du cœur sur la fiche : la page Favoris rend les tuiles
// sans aucun fetch, hors ligne compris. Les ids pré-persistés sans entrée
// (avant l'ajout des métadonnées) restent fonctionnels pour `has` mais ne
// s'affichent pas dans la grille — ils réapparaissent au premier re-cœur.

export interface ExternalFavoriteEntry {
  /** Id du titre SANS préfixe (l'id brute /vod/x/<id>). */
  id: string;
  title: string;
  posterUrl: string | null;
  kind: 'MOVIE' | 'SERIES';
  year: number | null;
  addedAt: string;
}

export interface ExternalFavoriteMeta {
  title: string;
  posterUrl: string | null;
  kind: 'MOVIE' | 'SERIES';
  year: number | null;
}

interface ExternalFavoritesState {
  ids: string[];
  entries: ExternalFavoriteEntry[];
  toggle: (externalId: string) => void;
  /** Toggle avec métadonnées : la voie utilisée par les fiches — ajoute
   * l'entrée d'affichage en même temps que l'id. */
  toggleWithMeta: (externalId: string, meta: ExternalFavoriteMeta) => void;
  /** Retrait direct (corbeille de la page Favoris), id préfixé. */
  remove: (externalId: string) => void;
  has: (externalId: string) => boolean;
}

export const useExternalFavoritesStore = create<ExternalFavoritesState>()(
  persist(
    (set, get) => ({
      ids: [],
      entries: [],
      toggle: (externalId) => {
        const previous = get().ids;
        set({
          ids: previous.includes(externalId)
            ? previous.filter((id) => id !== externalId)
            : [...previous, externalId],
        });
      },
      toggleWithMeta: (externalId, meta) => {
        const rawId = stripExternalPrefix(externalId);
        const previous = get().ids;
        const previousEntries = get().entries;
        if (previous.includes(externalId)) {
          set({
            ids: previous.filter((id) => id !== externalId),
            entries: previousEntries.filter((entry) => entry.id !== rawId),
          });
          return;
        }
        set({
          ids: [...previous, externalId],
          entries: [
            ...previousEntries,
            { id: rawId, ...meta, addedAt: new Date().toISOString() },
          ],
        });
      },
      has: (externalId) => get().ids.includes(externalId),
      remove: (externalId) => {
        // ids préfixés (« x:<id> »), entrées en id brut : la comparaison passe
        // par la forme brute pour nettoyer les deux espaces ensemble.
        const target = stripExternalPrefix(externalId);
        set({
          ids: get().ids.filter((id) => stripExternalPrefix(id) !== target),
          entries: get().entries.filter((entry) => stripExternalPrefix(entry.id) !== target),
        });
      },
    }),
    {
      name: 'mbolo-external-favorites',
      version: 1,
      // v1 : les entrées portaient l'id PRÉFIXÉ (« x:<id> ») au lieu de l'id
      // brut — les hrefs /vod/x/<id> cassaient (« Contenu introuvable »).
      // Migration : purge du préfixe à la rehydration.
      migrate: (persisted) => {
        const state = persisted as Partial<ExternalFavoritesState> | undefined;
        return {
          ids: state?.ids ?? [],
          entries: (state?.entries ?? []).map((entry) => ({ ...entry, id: stripExternalPrefix(entry.id) })),
        } as Partial<ExternalFavoritesState>;
      },
    },
  ),
);

/** Normalise un identifiant externe : retire le préfixe « x: » s'il existe. */
function stripExternalPrefix(id: string): string {
  return id.startsWith('x:') ? id.slice(2) : id;
}

/** Id de favori pour un titre externe (cohabite avec les autres espaces d'ids). */
export function externalFavoriteId(titleId: string): string {
  return `x:${titleId}`;
}
