import type { Channel, Category } from '@mbolo/contracts';
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { apiGet } from '../../../shared/api/client';
import { useCategories, useChannelRow, useChannelsByCountry } from '../../../shared/api/queries';
import { useFavoritesStore } from '../../../shared/stores/favorites';
import { useSettingsStore } from '../../../shared/stores/settings';

// Moteur de recommandation 100 % local (aucun service externe, aucune clé) :
// il apprend des habitudes déjà tracées dans l'app — favoris et historique de
// visionnage persistés — et en déduit deux rangées pour la page /live :
//   1. « Chaînes · <pays> »  : le pays le plus regardé (cold-start : déduit de
//      la langue du navigateur),
//   2. « Recommandés pour toi » : chaînes des dossiers les plus regardés,
//      scorées par affinité genre/pays, fraîcheur du programme et santé du flux.

const DAY_MS = 86_400_000;
const MAX_ROWS = 24;
const MAX_HISTORY_DETAILS = 14;
const FAVORITE_WEIGHT = 3;
const HISTORY_TODAY_WEIGHT = 4;
const HISTORY_WEEK_WEIGHT = 2;
const HISTORY_OLD_WEIGHT = 1;

type CatNode = Category & { children?: CatNode[] };

export interface Recommendations {
  hasHistory: boolean;
  /** Code pays mis en avant (déduit de l'historique, sinon de la langue). */
  countryCode?: string;
  countryRow: Channel[];
  forYou: Channel[];
}

function watchedWeight(watchedAt: string): number {
  const ageDays = (Date.now() - new Date(watchedAt).getTime()) / DAY_MS;
  if (ageDays <= 1) return HISTORY_TODAY_WEIGHT;
  if (ageDays <= 7) return HISTORY_WEEK_WEIGHT;
  return HISTORY_OLD_WEIGHT;
}

function guessLocaleCountry(): string | undefined {
  try {
    const region = navigator.language?.split('-')[1];
    return region ? region.toUpperCase() : undefined;
  } catch {
    return undefined;
  }
}

export function useRecommendations(): Recommendations {
  const favoriteIds = useFavoritesStore((state) => state.ids);
  const lastWatched = useSettingsStore((state) => state.lastWatched);
  const categories = useCategories().data ?? [];

  // Index id → {slug, name} de tout l'arbre des dossiers publiés.
  const categoryIndex = useMemo(() => {
    const map = new Map<string, { slug: string; name: string }>();
    const walk = (nodes: CatNode[]): void => {
      for (const node of nodes ?? []) {
        map.set(node.id, { slug: node.slug, name: node.name });
        if (node.children?.length) walk(node.children);
      }
    };
    walk(categories as CatNode[]);
    return map;
  }, [categories]);

  // Détails (categoryId, pays, santé…) des chaînes qui définissent le profil :
  // favoris (plafonnés) + dernières chaînes regardées.
  const profileIds = useMemo(
    () => [...new Set([...favoriteIds.slice(0, 8), ...lastWatched.map((entry) => entry.channelId)])].slice(0, MAX_HISTORY_DETAILS),
    [favoriteIds, lastWatched],
  );
  const detailResults = useQueries({
    queries: profileIds.map((id) => ({
      queryKey: ['channel', id],
      queryFn: () => apiGet<Channel>(`/channels/${id}`),
      staleTime: 5 * 60_000,
    })),
  });
  const watchedAtById = useMemo(
    () => new Map(lastWatched.map((entry) => [entry.channelId, entry.watchedAt])),
    [lastWatched],
  );

  // Affinités genre / pays pondérées (favori > vu récemment > vu anciennement).
  const { genreAffinity, countryAffinity } = useMemo(() => {
    const genre = new Map<string, number>();
    const country = new Map<string, number>();
    const bump = (map: Map<string, number>, key: string | null | undefined, weight: number): void => {
      if (!key) return;
      map.set(key, (map.get(key) ?? 0) + weight);
    };
    detailResults.forEach((result, index) => {
      const channel = result.data;
      if (!channel) return;
      const id = profileIds[index];
      let weight = 0;
      if (favoriteIds.includes(id)) weight += FAVORITE_WEIGHT;
      const seenAt = watchedAtById.get(id);
      if (seenAt) weight += watchedWeight(seenAt);
      if (weight === 0) return;
      // Valeur brute du pays : le filtre serveur est une égalité exacte sur
      // la colonne, on ne peut pas se permettre de normaliser la casse ici.
      bump(genre, channel.categoryId, weight);
      bump(country, channel.country || undefined, weight);
    });
    return { genreAffinity: genre, countryAffinity: country };
  }, [detailResults.map((result) => result.dataUpdatedAt).join(','), profileIds, favoriteIds, watchedAtById]);

  const topGenreSlugs = useMemo(
    () =>
      [...genreAffinity.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => categoryIndex.get(id)?.slug)
        .filter((slug): slug is string => Boolean(slug))
        .slice(0, 2),
    [genreAffinity, categoryIndex],
  );

  const hasHistory = favoriteIds.length > 0 || lastWatched.length > 0;
  const topCountry =
    [...countryAffinity.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (hasHistory ? undefined : guessLocaleCountry());

  // Deux requêtes fixes (ordre stable) alimentées par les meilleurs dossiers ;
  // désactivées tant que le profil n'est pas connu.
  const genreRowA = useChannelRow(topGenreSlugs[0], MAX_ROWS, Boolean(topGenreSlugs[0]));
  const genreRowB = useChannelRow(topGenreSlugs[1], MAX_ROWS, Boolean(topGenreSlugs[1]));
  const countryQuery = useChannelsByCountry(topCountry, MAX_ROWS, Boolean(topCountry));

  const excludedIds = useMemo(() => new Set([...favoriteIds, ...profileIds]), [favoriteIds, profileIds]);

  const forYou = useMemo(() => {
    const rows = [
      { items: genreRowA.data?.items ?? [], weight: 2 },
      { items: genreRowB.data?.items ?? [], weight: 1 },
    ];
    const scored = new Map<string, { channel: Channel; score: number }>();
    for (const row of rows) {
      for (const channel of row.items) {
        if (excludedIds.has(channel.id)) continue;
        const score =
          row.weight +
          (channel.nowPlaying ? 1 : 0) +
          (channel.healthStatus === 'DOWN' ? -2 : 0.3) +
          (topCountry && channel.country === topCountry ? 1 : 0);
        const existing = scored.get(channel.id);
        if (!existing || existing.score < score) scored.set(channel.id, { channel, score });
      }
    }
    return [...scored.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_ROWS)
      .map((entry) => entry.channel);
  }, [genreRowA.data, genreRowB.data, excludedIds, topCountry]);

  const countryRow = useMemo(() => {
    if (!topCountry) return [];
    const seen = new Set(forYou.map((channel) => channel.id));
    return (countryQuery.data?.items ?? [])
      .filter((channel) => !seen.has(channel.id))
      .sort((a, b) => Number(Boolean(b.nowPlaying)) - Number(Boolean(a.nowPlaying)))
      .slice(0, MAX_ROWS);
  }, [topCountry, countryQuery.data, forYou]);

  return { hasHistory, countryCode: topCountry, countryRow, forYou };
}
