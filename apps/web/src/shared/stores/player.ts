'use client';

import { create } from 'zustand';

interface PlayerState {
  /** Chaîne en lecture hors de la page watch (mini-lecteur global). */
  channelId: string | null;
  /** Lien watch complet (contexte dossier/pays/recherche) pour rouvrir en grand. */
  watchHref: string | null;
  setSource: (channelId: string, watchHref: string) => void;
  clear: () => void;
}

/** Posé par la page watch à chaque changement de chaîne ; lu par GlobalPlayer
 * pour faire survivre la lecture à une navigation vers /live ou /favorites. */
export const usePlayerStore = create<PlayerState>((set) => ({
  channelId: null,
  watchHref: null,
  setSource: (channelId, watchHref) => set({ channelId, watchHref }),
  clear: () => set({ channelId: null, watchHref: null }),
}));
