'use client';

import { Badge, Button, ChannelRow, EmptyState, Player, Spinner } from '@mbolo/ui';
import { useParams, useRouter } from 'next/navigation';
import { useMemo } from 'react';
import {
  useChannel,
  useChannelEpg,
  useChannels,
  usePlayUrl,
} from '../../../../shared/api/queries';
import { FavoriteToggle } from '../../../../shared/components/FavoriteToggle';

export default function WatchPage() {
  const params = useParams<{ channelId: string }>();
  const router = useRouter();
  const channelId = params.channelId;

  const channelQuery = useChannel(channelId);
  const epgQuery = useChannelEpg(channelId);
  const playQuery = usePlayUrl(channelId);
  const channelsQuery = useChannels({ limit: 100 });

  const { now, next } = useMemo(() => {
    const programmes = epgQuery.data ?? [];
    const nowTime = Date.now();
    const current = programmes.find(
      (programme) =>
        new Date(programme.startsAt).getTime() <= nowTime &&
        new Date(programme.endsAt).getTime() > nowTime,
    );
    const following =
      programmes.find((programme) => new Date(programme.startsAt).getTime() > nowTime) ?? null;
    return { now: current ?? null, next: following };
  }, [epgQuery.data]);

  const navigate = (direction: 'prev' | 'next') => {
    const channels = channelsQuery.data?.items ?? [];
    const index = channels.findIndex((channel) => channel.id === channelId);
    if (index === -1) return;
    const target =
      direction === 'next'
        ? channels[(index + 1) % channels.length]
        : channels[(index - 1 + channels.length) % channels.length];
    if (target) router.push(`/watch/${target.id}`);
  };

  if (channelQuery.isLoading || !channelQuery.data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--mbolo-space-8)' }}>
        <Spinner />
      </div>
    );
  }

  const channel = channelQuery.data;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--mbolo-space-4)', marginBottom: 'var(--mbolo-space-5)' }}>
        <h1 className="pageTitle" style={{ margin: 0, flex: 1 }}>
          {channel.name}
          {channel.country && <Badge tone="accent">{channel.country}</Badge>}
        </h1>
        <FavoriteToggle channelId={channel.id} />
        <Button variant="ghost" size="small" onClick={() => navigate('prev')}>
          ← Précédente
        </Button>
        <Button variant="ghost" size="small" onClick={() => navigate('next')}>
          Suivante →
        </Button>
      </div>

      {playQuery.isLoading ? (
        <div style={{ aspectRatio: '16 / 9', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', borderRadius: 'var(--mbolo-radius-lg)' }}>
          <Spinner />
        </div>
      ) : playQuery.data ? (
        <Player src={playQuery.data.url} title={channel.name} />
      ) : (
        <EmptyState title="Lecture indisponible" hint="Impossible de récupérer un flux pour cette chaîne." />
      )}

      <div style={{ marginTop: 'var(--mbolo-space-5)' }}>
        {now ? (
          <ChannelRow channel={channel} now={now} next={next} />
        ) : (
          <EmptyState title="Aucune programmation" hint="Pas de programme en cours pour cette chaîne." />
        )}
      </div>
    </>
  );
}
