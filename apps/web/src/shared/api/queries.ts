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
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { apiGet, apiPost } from './client';

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

export function useChannel(id: string) {
  return useQuery({
    queryKey: ['channel', id],
    queryFn: () => apiGet<Channel>(`/channels/${id}`),
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
  });
}

export function useChannelEpg(id: string) {
  return useQuery({
    queryKey: ['channel-epg', id],
    queryFn: () => apiGet<Programme[]>(`/channels/${id}/epg`),
  });
}

export function usePlayUrl(id: string) {
  return useQuery({
    queryKey: ['play', id],
    queryFn: () => apiGet<PlayResponse>(`/channels/${id}/play`),
    // Les URLs de lecture pointent désormais directement vers les fournisseurs
    // (via le proxy edge) et peuvent embarquer des tokens à vie courte :
    // on re-valide au clic après 60 s au lieu des 30 min de l'ère session-gateway.
    staleTime: 60_000,
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
