import type {
  Category,
  Channel,
  ChannelListResponse,
  ChannelQuery,
  EpgRangeQuery,
  EpgRangeResponse,
  Match,
  MatchListResponse,
  MatchQuery,
  PlayResponse,
  Programme,
} from '@mbolo/contracts';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';

export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: () => apiGet<Category[]>('/categories'),
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

export function useMatches(params: MatchQuery) {
  return useQuery({
    queryKey: ['matches', params],
    queryFn: () => apiGet<MatchListResponse>('/matches', params),
  });
}

export type { Match };
