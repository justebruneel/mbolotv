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
  setVolume: (volume: number) => void;
  setPreferredLevel: (level: number) => void;
  setDataSaver: (enabled: boolean) => void;
  recordWatch: (channelId: string, name: string) => void;
  clearLastWatched: () => void;
}

const MAX_LAST_WATCHED = 5;

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      volume: 1,
      preferredLevel: -1,
      dataSaver: false,
      lastWatched: [],
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
    { name: 'mbolo-settings' },
  ),
);
