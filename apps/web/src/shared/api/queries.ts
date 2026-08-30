import type {
  ActiveCountsResponse,
  Category,
  Channel,
  ChannelListResponse,
  ChannelQuery,
  ChannelViewersResponse,
  CountryOption,
  MatchListResponse,
  PlayResponse,
  Programme,
  ProgrammeSearchResponse,
} from '@mbolo/contracts';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { apiGet, apiPost } from './client';
import { useSettingsStore } from '../stores/settings';
import { useFavoritesStore } from '../stores/favorites';

export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: () => apiGet<Category[]>('/categories'),
  });
}

export function useCountries() {
  return useQuery({
    queryKey: ['countries'],
    queryFn: () => apiGet<CountryOption[]>('/channels/countries'),
  });
}

export function useChannels(params: ChannelQuery) {
  return useQuery({
    queryKey: ['channels', params],
    queryFn: () => apiGet<ChannelListResponse>('/channels', params),
  });
}

export function useChannel(id: string, enabled = true) {
  return useQuery({
    queryKey: ['channel', id],
    queryFn: () => apiGet<Channel>(`/channels/${id}`),
    enabled,
  });
}

export function useChannelRow(category: string | undefined, limit = 24, enabled = true) {
  return useQuery({
    queryKey: ['channels-row', category],
    queryFn: () => apiGet<ChannelListResponse>('/channels', { category, limit }),
    enabled: enabled && !!category,
    staleTime: 5 * 60_000,
  });
}

export function useChannelsByCountry(country: string | undefined, limit = 24, enabled = true) {
  return useQuery({
    queryKey: ['channels-country', country, limit],
    queryFn: () => apiGet<ChannelListResponse>('/channels', { country, limit }),
    enabled: enabled && !!country,
    staleTime: 5 * 60_000,
  });
}

/** Pays détecté côté Cloudflare + sélection « mis en avant » curée en console. */
export function useGeoFeatured() {
  return useQuery({
    queryKey: ['geo-featured'],
    queryFn: () => apiGet<{ country: string | null; channels: Channel[] }>('/geo/featured'),
    staleTime: 10 * 60_000,
  });
}

export function useInfiniteChannels(params: ChannelQuery, pageSize = 48) {
  const { category, country, q, offset: _offset, limit: _limit, ...rest } = params;
  return useInfiniteQuery({
    queryKey: ['channels', category, country, q ?? ''],
    queryFn: ({ pageParam }) =>
      apiGet<ChannelListResponse>('/channels', {
        ...rest,
        category,
        country,
        q,
        limit: pageSize,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.reduce((count, page) => count + page.items.length, 0) : undefined,
    placeholderData: keepPreviousData,
  });
}

export function useChannelEpg(id: string) {
  return useQuery({
    queryKey: ['channel-epg', id],
    queryFn: () => apiGet<Programme[]>(`/channels/${id}/epg`),
  });
}

export function usePlayUrl(id: string, enabled = true) {
  return useQuery({
    // Pas d'« eco » dans la clé : basculer Éco en cours de lecture ne doit pas
    // changer l'URL (donc pas de redémarrage du flux) — le plafonnement est
    // appliqué instantanément côté hls.js, et la valeur courante de dataSaver
    // est lue au moment du fetch pour les chargements suivants.
    queryKey: ['play', id],
    queryFn: () =>
      apiGet<PlayResponse>(
        `/channels/${id}/play`,
        useSettingsStore.getState().dataSaver ? { eco: 1 } : undefined,
      ),
    // Les URLs de lecture pointent directement vers les fournisseurs (via le
    // proxy edge) et embarquent un jeton fournisseur : on force une revalidation
    // réseau au clic après 60 s (refetch) au lieu des 30 min historiques.
    staleTime: 60_000,
    enabled,
  });
}

export function useProgrammeSearch(q: string, limit = 20) {
  const trimmed = q.trim();
  return useQuery({
    queryKey: ['programmes-search', trimmed, limit],
    queryFn: () => apiGet<ProgrammeSearchResponse>('/programmes/search', { q: trimmed, limit }),
    enabled: trimmed.length >= 2,
    staleTime: 30_000,
  });
}

export function useActiveUsers() {
  return useQuery({
    queryKey: ['active-users'],
    queryFn: () => apiGet<ActiveCountsResponse>('/activity/counts'),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

export function useMatches(state?: 'LIVE' | 'SCHEDULED') {
  return useQuery({
    queryKey: ['matches', state ?? 'all'],
    queryFn: () => apiGet<MatchListResponse>('/matches', state ? { state } : undefined),
    staleTime: 60_000,
    refetchInterval: state === 'LIVE' ? 60_000 : undefined,
  });
}

export function useChannelViewers(channelId: string, enabled = true) {
  return useQuery({
    queryKey: ['channel-viewers', channelId],
    queryFn: () => apiGet<ChannelViewersResponse>(`/activity/viewers/${channelId}`),
    refetchInterval: 15_000,
    staleTime: 10_000,
    enabled,
  });
}

/** Favoris de l'appareil : chaînes complètes, les plus récemment ajoutées d'abord. */
export function useFavorites(enabled = true) {
  return useQuery({
    queryKey: ['favorites'],
    queryFn: () => apiGet<ChannelListResponse>('/favorites'),
    enabled,
    staleTime: 30_000,
  });
}

/** Synchronise le store local avec la liste serveur (au montage de l'app) :
 * au premier passage, les favoris localStorage inconnus du serveur y sont
 * importés — ensuite le serveur fait foi, pour que les retraits faits sur
 * un autre appareil ne ressuscitent pas ici. */
export function useFavoritesSync(): void {
  useEffect(() => {
    let cancelled = false;
    void apiGet<ChannelListResponse>('/favorites')
      .then((data) => {
        if (cancelled) return;
        useFavoritesStore.getState().syncFromServer(data.items.map((channel) => channel.id));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
}

export function useActivityHeartbeat(channelId?: string) {
  useEffect(() => {
    const send = () => {
      void apiPost('/activity/heartbeat', { channelId }).catch(() => {});
    };
    send();
    const interval = setInterval(send, 30_000);
    return () => clearInterval(interval);
  }, [channelId]);
}

// Requête large dédiée (clé propre) pour la rangée favoris — ne partage PAS
// la clé ['channels', …] avec les requêtes paginées (sinon refetch en boucle).
export function useWideChannels(limit = 200, enabled = true) {
  return useQuery({
    queryKey: ["channels-wide", limit],
    queryFn: () => apiGet<ChannelListResponse>("/channels", { limit }),
    enabled,
    staleTime: 60_000,
  });
}

export function useFeatured(limit = 5) {
  return useQuery({
    queryKey: ['featured', limit],
    queryFn: () => apiGet<{ channelId: string; programme: { title: string; description: string | null; startsAt: string; endsAt: string; imageUrl: string | null; posterUrl: string | null; backdropUrl: string | null; trailerUrl: string | null; type: string | null } }[]>(`/epg/featured?limit=${limit}`),
    staleTime: 5 * 60_000,
  });
}
