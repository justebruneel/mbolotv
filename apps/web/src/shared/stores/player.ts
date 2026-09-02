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

interface VodPlayerState {
  /** Item VOD (film ou série) en lecture hors de la page /vod/[id]. */
  vodItemId: string | null;
  /** Saison/épisode courant pour une série (1/1 par défaut). */
  season: number;
  episode: number;
  setVodSource: (vodItemId: string, season: number, episode: number) => void;
  setVodEpisode: (season: number, episode: number) => void;
  clearVod: () => void;
}

/** Posé par la page /vod/[id] ; lu par GlobalPlayer pour la reprise de lecture
 * VOD hors de la fiche (mini-lecteur). Séparé du store chaînes pour ne pas
 * créer d'ambiguïté d'id entre Channel et VodItem. */
export const useVodPlayerStore = create<VodPlayerState>((set) => ({
  vodItemId: null,
  season: 1,
  episode: 1,
  setVodSource: (vodItemId, season, episode) => set({ vodItemId, season, episode }),
  setVodEpisode: (season, episode) => set({ season, episode }),
  clearVod: () => set({ vodItemId: null, season: 1, episode: 1 }),
}));
