import type {
  ActiveCountsResponse,
  AnnouncementList,
  Category,
  Channel,
  ChannelListResponse,
  ChannelQuery,
  ChannelViewersResponse,
  CountryOption,
  EpgRangeResponse,
  MatchListResponse,
  PlayResponse,
  Programme,
  ProgrammeSearchResponse,
  ReminderList,
  VodCategory,
  VodItem,
  VodKind,
  VodHeroResponse,
  VodListResponse,
  VodRowsResponse,
  VodSeasonsResponse,
} from '@mbolo/contracts';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { apiGet, apiPost } from './client';
import { useSettingsStore } from '../stores/settings';
import { useFavoritesStore } from '../stores/favorites';
import { useRemindersStore } from '../stores/reminders';
import { useWhatsNewStore } from '../stores/whatsNew';

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

/** Grille des programmes d'une plage horaire (page Programmes). */
export function useEpgRange(from: Date, to: Date, category?: string) {
  return useQuery({
    queryKey: ['epg', from.toISOString(), to.toISOString(), category ?? ''],
    queryFn: () => apiGet<EpgRangeResponse>('/epg/range', { from: from.toISOString(), to: to.toISOString(), category }),
    staleTime: 2 * 60_000,
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

/** Annonces publiées par l'administrateur (« Quoi de neuf »). */
export function useAnnouncements(enabled = true) {
  return useQuery({
    queryKey: ['announcements'],
    queryFn: () => apiGet<AnnouncementList>('/announcements'),
    enabled,
    staleTime: 60_000,
  });
}

/** Nombre d'annonces plus récentes que la dernière lecture (badge menu). */
export function useUnreadAnnouncements(): number {
  const { data } = useAnnouncements();
  const lastReadAt = useWhatsNewStore((state) => state.lastReadAt);
  const items = data?.items ?? [];
  if (items.length === 0) return 0;
  if (!lastReadAt) return items.length;
  return items.filter((item) => item.createdAt > lastReadAt).length;
}

/** Synchronise les rappels locaux avec le serveur (au montage de l'app),
 * même logique d'import unique que les favoris. */
export function useRemindersSync(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    void queryClient
      .fetchQuery({ queryKey: ['reminders'], queryFn: () => apiGet<ReminderList>('/reminders'), staleTime: 30_000 })
      .then((data) => useRemindersStore.getState().syncFromServer(data.items))
      .catch(() => undefined);
  }, [queryClient]);
}

/** Synchronise le store local avec la liste serveur (au montage de l'app) :
 * au premier passage, les favoris localStorage inconnus du serveur y sont
 * importés — ensuite le serveur fait foi, pour que les retraits faits sur
 * un autre appareil ne ressuscitent pas ici. */
export function useFavoritesSync(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    // Même clé que useFavorites : une seule requête partagée au démarrage.
    void queryClient
      .fetchQuery({ queryKey: ['favorites'], queryFn: () => apiGet<ChannelListResponse>('/favorites'), staleTime: 30_000 })
      .then((data) => useFavoritesStore.getState().syncFromServer(data.items.map((channel) => channel.id)))
      .catch(() => undefined);
  }, [queryClient]);
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

// ---- VOD (films & séries) ---------------------------------------------------

export function useInfiniteVod(params: { kind?: VodKind; category?: string; q?: string }, pageSize = 48) {
  const { kind, category, q } = params;
  return useInfiniteQuery({
    queryKey: ['vod', kind ?? 'all', category ?? '', q ?? ''],
    queryFn: ({ pageParam }) =>
      apiGet<VodListResponse>('/vod', { kind, category, q, limit: pageSize, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.reduce((count, page) => count + page.items.length, 0) : undefined,
    placeholderData: keepPreviousData,
  });
}

export function useVodCategories(kind?: VodKind) {
  return useQuery({
    queryKey: ['vod-categories', kind ?? 'all'],
    queryFn: () => apiGet<VodCategory[]>('/vod/categories', { kind }),
    staleTime: 5 * 60_000,
  });
}

// Accueil Netflix : rangées par catégorie en un aller-retour.
export function useVodRows(kind?: VodKind) {
  return useQuery({
    queryKey: ['vod-rows', kind ?? 'all'],
    queryFn: () => apiGet<VodRowsResponse>('/vod/rows', { kind }),
    staleTime: 5 * 60_000,
  });
}

export function useVodHero(kind?: VodKind) {
  return useQuery({
    queryKey: ['vod-hero', kind ?? 'all'],
    queryFn: () => apiGet<VodHeroResponse>('/vod/hero', { kind }),
    staleTime: 5 * 60_000,
  });
}

export function useVodItem(id: string, enabled = true) {
  return useQuery({
    queryKey: ['vod-item', id],
    queryFn: () => apiGet<VodItem>(`/vod/${id}`),
    enabled: enabled && Boolean(id),
    staleTime: 5 * 60_000,
  });
}

// ---- YouTube (onglet Nollywood) : pagination par pageToken (prochain appel
// = pageToken renvoyé), miroir du défilement infini VOD.
export const YOUTUBE_AFOREVO_CHANNEL_ID = 'UCyd79F-lNLCbGPQrf_L7KiA';

export function useInfiniteYoutube(channelId: string, pageSize = 25, q = '') {
  return useInfiniteQuery({
    queryKey: ['vod-youtube', channelId, pageSize, q],
    queryFn: ({ pageParam }) =>
      // Direct navigateur d'abord (egress serveurs filtrés côté Google),
      // proxy serveur en repli — voir features/vod/youtubeClient.ts.
      import('../../features/vod/youtubeClient').then(({ fetchYoutubeList }) =>
        fetchYoutubeList(channelId, {
          ...(q.trim() ? { q: q.trim() } : {}),
          ...(pageParam ? { pageToken: pageParam } : {}),
          maxResults: pageSize,
        }),
      ),
    initialPageParam: '' as string,
    // Garde page vide : YouTube renvoie parfois items:[] AVEC un token —
    // suivre ce token bouclerait indéfiniment sur des pages vides.
    getNextPageParam: (lastPage) => (lastPage.nextPageToken && lastPage.items.length > 0 ? lastPage.nextPageToken : undefined),
    placeholderData: keepPreviousData,
    // Coût quota : search.list = 100 unités, playlistItems = 1. staleTime 5 min
    // évite le refetch systématique au remontage de la liste (le cache
    // sessionStorage de youtubeClient prend le relais ensuite).
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    // JAMAIS de retry sur 429/403/451 : un retry 3× sur search.list amplifie
    // l'épuisement du quota (4 × 100 unités pour le même appel). On retente
    // seulement les erreurs réseau/5xx.
    retry: (failureCount, error) => {
      const status = error instanceof Error && 'status' in error ? Number((error as { status?: unknown }).status) : 0;
      if (status === 429 || status === 403 || status === 451) return false;
      return failureCount < 1;
    },
  });
}

export function useYoutubeVideo(videoId: string, enabled = true) {
  return useQuery({
    queryKey: ['vod-youtube-video', videoId],
    queryFn: () =>
      import('../../features/vod/youtubeClient').then(({ fetchYoutubeVideo }) => fetchYoutubeVideo(videoId)),
    enabled: enabled && Boolean(videoId),
    staleTime: 60 * 60_000,
  });
}

// Flux direct (InnerTube) pour le lecteur maison : liste d'URLs MP4 avec
// repli automatique. 30 min de fraîcheur — les URL expirent ~6 h côté Google.
export function useYoutubePlay(videoId: string, enabled = true) {
  return useQuery({
    queryKey: ['vod-youtube-play', videoId],
    queryFn: async (): Promise<{ urls: string[] }> => {
      const response = await fetch(`/api/yt/play?id=${encodeURIComponent(videoId)}`, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Flux indisponible (${response.status})`);
      }
      return (await response.json()) as { urls: string[] };
    },
    enabled: enabled && Boolean(videoId),
    staleTime: 30 * 60_000,
    retry: false,
  });
}

export function useVodEpisodes(id: string, enabled = true) {
  return useQuery({
    queryKey: ['vod-episodes', id],
    queryFn: () => apiGet<VodSeasonsResponse>(`/vod/${id}/episodes`),
    enabled: enabled && Boolean(id),
    staleTime: 10 * 60_000,
  });
}

// L'URL de lecture VOD embarque le couple saison/épisode dans la clé : changer
// d'épisode relance une requête (nouvelle URL signée, nouveau fichier).
export function useVodPlayUrl(id: string, params: { s?: number; e?: number }, enabled = true) {
  return useQuery({
    queryKey: ['vod-play', id, params.s ?? 1, params.e ?? 1],
    queryFn: () =>
      apiGet<PlayResponse>(
        `/vod/${id}/play`,
        params.s || params.e ? { s: params.s, e: params.e } : undefined,
      ),
    staleTime: 60_000,
    enabled: enabled && Boolean(id),
  });
}

export function useVodFavorites(enabled = true) {
  return useQuery({
    queryKey: ['vod-favorites'],
    queryFn: () => apiGet<{ items: VodItem[] }>('/vod/favorites'),
    staleTime: 30_000,
    enabled,
  });
}
