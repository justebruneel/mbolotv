import type {
  Category,
  Channel,
  ChannelListResponse,
  ChannelQuery,
  CountryOption,
  EpgRangeQuery,
  EpgRangeResponse,
  Match,
  MatchListResponse,
  MatchQuery,
  PlayResponse,
  Programme,
  ProgrammeSearchResponse,
} from '@mbolo/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
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
    staleTime: 30 * 60_000,
  });
}

export function useEpgRange(params: EpgRangeQuery) {
  return useQuery({
    queryKey: ['epg-range', params],
    queryFn: () => apiGet<EpgRangeResponse>('/epg/range', params),
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

export function useMatches(params: MatchQuery, refetchInterval = 0) {
  return useQuery({
    queryKey: ['matches', params],
    queryFn: () => apiGet<MatchListResponse>('/matches', params),
    refetchInterval: refetchInterval || undefined,
  });
}

export function useMatch(id: string, refetchInterval = 0) {
  return useQuery({
    queryKey: ['match', id],
    queryFn: () => apiGet<Match>(`/matches/${id}`),
    enabled: !!id,
    refetchInterval: refetchInterval || undefined,
  });
}

export function useMatchPlay(matchId: string, channelId?: string) {
  return useQuery({
    queryKey: ['match-play', matchId, channelId ?? 'best'],
    queryFn: () =>
      apiPost<PlayResponse>(`/matches/${matchId}/play`, channelId ? { channelId } : undefined),
    enabled: !!matchId,
    staleTime: 30 * 60_000,
  });
}

export type { Match };
