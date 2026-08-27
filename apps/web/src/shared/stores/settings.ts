'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface LastWatchedEntry {
  channelId: string;
  name: string;
  watchedAt: string;
}

interface SettingsState {
  volume: number;
  preferredLevel: number;
  dataSaver: boolean;
  lastWatched: LastWatchedEntry[];
  lastNonWatchPath: string | null;
  lastWatchedChannelId: string | null;
  browseViewMode: 'grid' | 'list';
  setVolume: (volume: number) => void;
  setPreferredLevel: (level: number) => void;
  setDataSaver: (dataSaver: boolean) => void;
  recordWatch: (channelId: string, name: string) => void;
  clearLastWatched: () => void;
  setLastNonWatchPath: (path: string) => void;
  setLastWatchedChannelId: (id: string | null) => void;
  setBrowseViewMode: (mode: 'grid' | 'list') => void;
}

const MAX_LAST_WATCHED = 5;

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      volume: 1,
      preferredLevel: -1,
      dataSaver: false,
      lastWatched: [],
      lastNonWatchPath: null,
      lastWatchedChannelId: null,
      browseViewMode: 'grid',
      setLastNonWatchPath: (path) => set({ lastNonWatchPath: path }),
      setLastWatchedChannelId: (id) => set({ lastWatchedChannelId: id }),
      setBrowseViewMode: (mode) => set({ browseViewMode: mode }),
      setVolume: (volume) => set({ volume }),
      setPreferredLevel: (preferredLevel) => set({ preferredLevel }),
      setDataSaver: (dataSaver) => set({ dataSaver }),
      recordWatch: (channelId, name) =>
        set((state) => ({
          lastWatched: [
            { channelId, name, watchedAt: new Date().toISOString() },
            ...state.lastWatched.filter((entry) => entry.channelId !== channelId),
          ].slice(0, MAX_LAST_WATCHED),
        })),
      clearLastWatched: () => set({ lastWatched: [] }),
    }),
    { name: 'mbolo-settings', partialize: (state) => ({ ...state, lastNonWatchPath: undefined, lastWatchedChannelId: undefined }) },
  ),
);
