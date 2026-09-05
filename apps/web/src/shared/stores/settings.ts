'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface LastWatchedEntry {
  channelId: string;
  name: string;
  watchedAt: string;
}

// Reprise de lecture VOD (100 % local, sans API) : position à la dernière
// lecture. Plafonné à MAX_VOD_PROGRESS entrées (les plus récentes gagnent).
export interface VodProgressEntry {
  id: string;
  kind: 'MOVIE' | 'SERIES';
  title: string;
  posterUrl: string | null;
  category: string | null;
  position: number;
  duration: number;
  updatedAt: string;
}

interface SettingsState {
  volume: number;
  preferredLevel: number;
  dataSaver: boolean;
  /** Démarrage automatique de la lecture à l'ouverture d'une chaîne. */
  autoPlay: boolean;
  /** Le mini-lecteur continue sur /live et /favorites. */
  miniPlayerOnBrowse: boolean;
  lastWatched: LastWatchedEntry[];
  lastNonWatchPath: string | null;
  lastWatchedChannelId: string | null;
  browseViewMode: 'grid' | 'list';
  vodProgress: Record<string, VodProgressEntry>;
  setVolume: (volume: number) => void;
  setPreferredLevel: (level: number) => void;
  setDataSaver: (dataSaver: boolean) => void;
  setAutoPlay: (autoPlay: boolean) => void;
  setMiniPlayerOnBrowse: (value: boolean) => void;
  recordWatch: (channelId: string, name: string) => void;
  clearLastWatched: () => void;
  setLastNonWatchPath: (path: string) => void;
  setLastWatchedChannelId: (id: string | null) => void;
  setBrowseViewMode: (mode: 'grid' | 'list') => void;
  recordVodProgress: (entry: VodProgressEntry) => void;
  clearVodProgress: (id: string) => void;
  clearAllVodProgress: () => void;
}

const MAX_LAST_WATCHED = 5;
const MAX_VOD_PROGRESS = 50;

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      volume: 1,
      preferredLevel: -1,
      dataSaver: false,
      autoPlay: true,
      miniPlayerOnBrowse: true,
      lastWatched: [],
      lastNonWatchPath: null,
      lastWatchedChannelId: null,
      browseViewMode: 'grid',
      vodProgress: {},
      setLastNonWatchPath: (path) => set({ lastNonWatchPath: path }),
      setLastWatchedChannelId: (id) => set({ lastWatchedChannelId: id }),
      setBrowseViewMode: (mode) => set({ browseViewMode: mode }),
      setVolume: (volume) => set({ volume }),
      setPreferredLevel: (preferredLevel) => set({ preferredLevel }),
      setDataSaver: (dataSaver) => set({ dataSaver }),
      setAutoPlay: (autoPlay) => set({ autoPlay }),
      setMiniPlayerOnBrowse: (miniPlayerOnBrowse) => set({ miniPlayerOnBrowse }),
      recordWatch: (channelId, name) =>
        set((state) => ({
          lastWatched: [
            { channelId, name, watchedAt: new Date().toISOString() },
            ...state.lastWatched.filter((entry) => entry.channelId !== channelId),
          ].slice(0, MAX_LAST_WATCHED),
        })),
      clearLastWatched: () => set({ lastWatched: [] }),
      recordVodProgress: (entry) =>
        set((state) => {
          // À moins de 30 s de la fin (ou écoulée) : on considère l'œuvre vue,
          // l'entrée quitte la file pour ne pas polluer « Reprendre ».
          const finished = entry.duration > 0 && entry.position >= entry.duration - 30;
          const next = { ...state.vodProgress };
          if (finished) delete next[entry.id];
          else {
            next[entry.id] = entry;
            const sorted = Object.values(next).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
            for (const stale of sorted.slice(MAX_VOD_PROGRESS)) delete next[stale.id];
          }
          return { vodProgress: next };
        }),
      clearVodProgress: (id) =>
        set((state) => {
          if (!(id in state.vodProgress)) return state;
          const next = { ...state.vodProgress };
          delete next[id];
          return { vodProgress: next };
        }),
      clearAllVodProgress: () => set({ vodProgress: {} }),
    }),
    { name: 'mbolo-settings', partialize: (state) => ({ ...state, lastNonWatchPath: undefined, lastWatchedChannelId: undefined }) },
  ),
);
