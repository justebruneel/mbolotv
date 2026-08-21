'use client';

import { Badge, Button, ChannelRow, EmptyState, Icon, Player, Spinner } from '@mbolo/ui';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import { useChannel, useChannelEpg, useChannelViewers, useInfiniteChannels, usePlayUrl, useActivityHeartbeat } from '../../../../shared/api/queries';
import { FavoriteToggle } from '../../../../shared/components/FavoriteToggle';
import { useSettingsStore } from '../../../../shared/stores/settings';
import { buildWatchHref } from '../../../../features/live-tv/utils';

const PAGE_SIZE = 48;

export default function WatchPage() {
  const params = useParams<{ channelId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const channelId = params.channelId;
  const category = searchParams.get('category') ?? undefined;
  const country = searchParams.get('country') ?? undefined;
  const q = searchParams.get('q') ?? undefined;
  const volume = useSettingsStore((state) => state.volume);
  const preferredLevel = useSettingsStore((state) => state.preferredLevel);
  const dataSaver = useSettingsStore((state) => state.dataSaver);
  const setVolume = useSettingsStore((state) => state.setVolume);
  const setPreferredLevel = useSettingsStore((state) => state.setPreferredLevel);
  const setDataSaver = useSettingsStore((state) => state.setDataSaver);
  const recordWatch = useSettingsStore((state) => state.recordWatch);
  const channelQuery = useChannel(channelId);
  const epgQuery = useChannelEpg(channelId);
  const playQuery = usePlayUrl(channelId);
  const channelsQuery = useInfiniteChannels({ category, country, q }, PAGE_SIZE);
  const navChannels = channelsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const viewersQuery = useChannelViewers(channelId);
  useActivityHeartbeat(channelId);
  const playUrls = useMemo(() => (playQuery.data?.url ? [playQuery.data.url] : []), [playQuery.data?.url]);

  useEffect(() => {
    if (channelQuery.data) recordWatch(channelId, channelQuery.data.name);
  }, [channelId, channelQuery.data, recordWatch]);

  useEffect(() => {
    if (!navChannels.some((channel) => channel.id === channelId) && channelsQuery.hasNextPage && !channelsQuery.isFetchingNextPage) {
      void channelsQuery.fetchNextPage();
    }
  }, [navChannels, channelId, channelsQuery]);

  const { now, next } = useMemo(() => {
    const programmes = epgQuery.data ?? [];
    const nowTime = Date.now();
    const current = programmes.find((programme) => new Date(programme.startsAt).getTime() <= nowTime && new Date(programme.endsAt).getTime() > nowTime);
    const following = programmes.find((programme) => new Date(programme.startsAt).getTime() > nowTime) ?? null;
    return { now: current ?? null, next: following };
  }, [epgQuery.data]);

  const navigate = (direction: 'prev' | 'next') => {
    const index = navChannels.findIndex((channel) => channel.id === channelId);
    if (index === -1) return;
    const target = direction === 'next' ? navChannels[(index + 1) % navChannels.length] : navChannels[(index - 1 + navChannels.length) % navChannels.length];
    if (target) router.push(buildWatchHref(target.id, { category, country, q }));
  };

  const goBack = (): void => {
    if (window.history.length > 1) router.back();
    else router.replace('/live');
  };

  if (channelQuery.isLoading || !channelQuery.data) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const channel = channelQuery.data;

  return (
    <div className="animate-fade-in">
      {/* Back button + channel name */}
      <div className="mb-4 flex items-center gap-3 animate-slide-up">
        <button
          type="button"
          onClick={goBack}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-muted transition-all duration-200 hover:bg-surface-2 hover:text-accent"
        >
          <Icon.ChevronLeft size={16} aria-hidden /> Retour
        </button>
        <h1 className="min-w-0 truncate text-2xl font-extrabold tracking-tight">{channel.name}</h1>
        {channel.country && (
          <Badge tone="accent" className="shrink-0">{channel.country}</Badge>
        )}
        {channel.nowPlaying && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-danger/90 px-2.5 py-1 text-[10px] font-bold tracking-wide text-white">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
            DIRECT
          </span>
        )}
      </div>

      {/* Actions row: favorites + viewers + navigation */}
      <div className="mb-6 flex flex-wrap items-center justify-center gap-2">
        <FavoriteToggle channelId={channel.id} />
        {viewersQuery.data && viewersQuery.data.count > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-muted px-2.5 py-1 text-xs font-bold text-accent">
            <Icon.Eye size={13} aria-hidden />
            {viewersQuery.data.count}
          </span>
        )}
        <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
          <Button variant="ghost" size="small" onClick={() => navigate('prev')} className="!rounded-lg">
            <Icon.ChevronLeft size={16} />
          </Button>
          <Button variant="ghost" size="small" onClick={() => navigate('next')} className="!rounded-lg">
            <Icon.ChevronRight size={16} />
          </Button>
        </div>
      </div>

      {/* Player */}
      <div>
        {playQuery.isLoading ? (
          <div className="aspect-video flex items-center justify-center rounded-2xl bg-surface border border-border">
            <Spinner />
          </div>
        ) : playUrls.length > 0 ? (
          <Player
            urls={playUrls}
            title={channel.name}
            initialVolume={volume}
            initialLevel={preferredLevel}
            initialDataSaver={dataSaver}
            onVolumeChange={setVolume}
            onLevelChange={setPreferredLevel}
            onDataSaverChange={setDataSaver}
          />
        ) : (
          <EmptyState title="Lecture indisponible" hint="Impossible de récupérer un flux pour cette chaîne." />
        )}
      </div>

      {/* EPG info */}
      <div className="mt-6 animate-slide-up stagger-2">
        {now ? (
          <ChannelRow channel={channel} now={now} next={next} />
        ) : (
          <EmptyState title="Aucune programmation" hint="Pas de programme en cours pour cette chaîne." />
        )}
      </div>
    </div>
  );
}
