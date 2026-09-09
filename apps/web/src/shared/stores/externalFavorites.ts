'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ExternalTitlePublic } from '@mbolo/contracts';
import { apiDelete, apiPut } from '../api/client';
import { sharedQueryClient } from '../components/QueryProvider';

// Favoris de titres externes (onglet Films & Séries, /vod/x) : local-first +
// synchronisation serveur — même motif que favorites.ts/vodFavorites.ts, avec
// EN PLUS les métadonnées d'affichage (`entries`, capturées au cœur sur la
// fiche) pour que la page Favoris rende les tuiles sans aucun fetch.
//
// Clés PRÉFIXÉES (« x:<titleId> ») côté ids, jamais mélangées aux autres
// espaces (VodFavorite rejette les ids étrangers à sa clé étrangère).
//
// La première synchro importe les favoris locaux inconnus du serveur (PUT) ;
// ensuite le serveur fait foi, pour que les retraits faits sur un autre
// appareil ne ressuscitent pas ici.

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
  /** true après la première synchronisation serveur réussie. */
  synced: boolean;
  toggle: (externalId: string) => void;
  /** Toggle avec métadonnées : la voie utilisée par les fiches — ajoute
   * l'entrée d'affichage en même temps que l'id. Optimiste + serveur. */
  toggleWithMeta: (externalId: string, meta: ExternalFavoriteMeta) => void;
  /** Retrait direct (corbeille de la page Favoris), id préfixé ou brut. */
  remove: (externalId: string) => void;
  has: (externalId: string) => boolean;
  syncFromServer: (serverItems: ExternalTitlePublic[]) => void;
}

function invalidateExternalFavorites(): void {
  void sharedQueryClient?.invalidateQueries({ queryKey: ['x-favorites'] });
}

/** Entrée d'affichage d'un titre serveur (aucune métadonnée locale connue) :
 * ajouté depuis un autre appareil — affiché dès la première réconciliation. */
function entryFromServer(item: ExternalTitlePublic): ExternalFavoriteEntry {
  return { id: item.id, title: item.title, posterUrl: item.posterUrl, kind: item.kind, year: item.year, addedAt: '' };
}

export const useExternalFavoritesStore = create<ExternalFavoritesState>()(
  persist(
    (set, get) => ({
      ids: [],
      entries: [],
      synced: false,
      toggle: (externalId) => {
        const rawId = stripExternalPrefix(externalId);
        const previous = get().ids;
        const adding = !previous.includes(externalId);
        set({ ids: adding ? [...previous, externalId] : previous.filter((id) => id !== externalId) });
        const call = adding
          ? apiPut(`/x/${encodeURIComponent(rawId)}/favorite`)
          : apiDelete(`/x/${encodeURIComponent(rawId)}/favorite`);
        void call.then(invalidateExternalFavorites).catch(() => {
          // Rollback optimiste : le serveur remonte (hors ligne, 4xx…) — on
          // revient à l'état d'avant, la fiche re-flashe son cœur.
          set({ ids: previous });
          invalidateExternalFavorites();
        });
      },
      toggleWithMeta: (externalId, meta) => {
        const rawId = stripExternalPrefix(externalId);
        const previous = get().ids;
        const previousEntries = get().entries;
        const adding = !previous.includes(externalId);
        if (adding) {
          set({
            ids: [...previous, externalId],
            entries: [
              ...previousEntries,
              { id: rawId, ...meta, addedAt: new Date().toISOString() },
            ],
          });
        } else {
          set({
            ids: previous.filter((id) => id !== externalId),
            entries: previousEntries.filter((entry) => entry.id !== rawId),
          });
        }
        const call = adding
          ? apiPut(`/x/${encodeURIComponent(rawId)}/favorite`)
          : apiDelete(`/x/${encodeURIComponent(rawId)}/favorite`);
        void call.then(invalidateExternalFavorites).catch(() => {
          set({ ids: previous, entries: previousEntries });
          invalidateExternalFavorites();
        });
      },
      has: (externalId) => get().ids.includes(externalId),
      remove: (externalId) => {
        const rawId = stripExternalPrefix(externalId);
        const previous = get().ids;
        const previousEntries = get().entries;
        set({
          ids: previous.filter((id) => stripExternalPrefix(id) !== rawId),
          entries: previousEntries.filter((entry) => entry.id !== rawId),
        });
        void apiDelete(`/x/${encodeURIComponent(rawId)}/favorite`).then(invalidateExternalFavorites).catch(() => {
          set({ ids: previous, entries: previousEntries });
          invalidateExternalFavorites();
        });
      },
      syncFromServer: (serverItems) => {
        const rawServer = serverItems.map((item) => item.id);
        const serverIds = serverItems.map((item) => externalFavoriteId(item.id));
        const local = get().ids;
        if (!get().synced) {
          // Premier passage : les favoris locaux inconnus du serveur y sont
          // importés, puis on réconcilie. Entrées : celles des ids gardés
          // (locaux importés + serveur), complétées par le serveur.
          const missingRaw = local.filter((id) => !rawServer.includes(stripExternalPrefix(id))).map(stripExternalPrefix);
          missingRaw.forEach((rawId) => void apiPut(`/x/${encodeURIComponent(rawId)}/favorite`).catch(() => undefined));
          const keepRaw = new Set([...rawServer, ...missingRaw]);
          const localEntries = get().entries.filter((entry) => keepRaw.has(entry.id));
          const knownRaw = new Set(localEntries.map((entry) => entry.id));
          const serverEntries = serverItems.filter((item) => !knownRaw.has(item.id)).map(entryFromServer);
          set({
            ids: [...serverIds, ...missingRaw.map(externalFavoriteId)],
            entries: [...localEntries, ...serverEntries],
            synced: true,
          });
          return;
        }
        // 2e synchro + : le serveur fait foi ; les ids retirés ailleurs
        // disparaissent, leurs entrées aussi (purge propre).
        const keepEntries = get().entries.filter((entry) => rawServer.includes(entry.id));
        const knownRaw = new Set(keepEntries.map((entry) => entry.id));
        const serverEntries = serverItems.filter((item) => !knownRaw.has(item.id)).map(entryFromServer);
        set({ ids: serverIds, entries: [...keepEntries, ...serverEntries] });
      },
    }),
    {
      name: 'mbolo-external-favorites',
      version: 2,
      // v1 : les entrées portaient l'id PRÉFIXÉ (« x:<id> ») au lieu de l'id
      // brut — les hrefs /vod/x/<id> cassaient (« Contenu introuvable »).
      // v2 : ajout du drapeau synced (la synchro serveur est désactivée
      // au premier hydrate, l'import initial repart de zéro).
      migrate: (persisted) => {
        const state = persisted as Partial<ExternalFavoritesState> | undefined;
        return {
          ids: state?.ids ?? [],
          entries: (state?.entries ?? []).map((entry) => ({ ...entry, id: stripExternalPrefix(entry.id) })),
          synced: false,
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