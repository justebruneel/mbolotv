'use client';

import { Badge, Button, ChannelRow, EmptyState, Icon, Player, Spinner } from '@mbolo/ui';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import { useChannel, useChannelEpg, useInfiniteChannels, usePlayUrl } from '../../../../shared/api/queries';
import { FavoriteToggle } from '../../../../shared/components/FavoriteToggle';
import { PageHeader } from '../../../../shared/components/PageHeader';
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

  if (channelQuery.isLoading || !channelQuery.data) return <div className="flex justify-center p-12"><Spinner /></div>;
  const channel = channelQuery.data;

  return (
    <>
      <button type="button" onClick={goBack} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-accent"><Icon.ChevronLeft size={15} aria-hidden /> Retour</button>
      <PageHeader
        title={<span className="flex items-center gap-2">{channel.name}{channel.country && <Badge tone="accent">{channel.country}</Badge>}</span>}
        actions={<><FavoriteToggle channelId={channel.id} /><Button variant="ghost" size="small" onClick={() => navigate('prev')}><Icon.ChevronLeft size={16} /> Précédente</Button><Button variant="ghost" size="small" onClick={() => navigate('next')}>Suivante <Icon.ChevronRight size={16} /></Button></>}
      />
      {playQuery.isLoading ? (
        <div className="aspect-video flex items-center justify-center rounded-2xl bg-black"><Spinner /></div>
      ) : playUrls.length > 0 ? (
        <Player urls={playUrls} title={channel.name} initialVolume={volume} initialLevel={preferredLevel} initialDataSaver={dataSaver} onVolumeChange={setVolume} onLevelChange={setPreferredLevel} onDataSaverChange={setDataSaver} />
      ) : (
        <EmptyState title="Lecture indisponible" hint="Impossible de récupérer un flux pour cette chaîne." />
      )}
      <div className="mt-5">{now ? <ChannelRow channel={channel} now={now} next={next} /> : <EmptyState title="Aucune programmation" hint="Pas de programme en cours pour cette chaîne." />}</div>
    </>
  );
}
