'use client';

import { ChannelCard, FavoriteButton } from '@mbolo/ui';
import type { Channel } from '@mbolo/contracts';
import { useRouter } from 'next/navigation';
import { useFavoritesStore } from '../../../shared/stores/favorites';
import { buildWatchHref, type WatchContext } from '../utils';

export function ChannelGrid({
  channels,
  watchContext,
}: {
  channels: Channel[];
  watchContext?: WatchContext;
}) {
  const router = useRouter();
  const has = useFavoritesStore((state) => state.has);
  const toggle = useFavoritesStore((state) => state.toggle);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 'var(--mbolo-space-4)',
      }}
    >
      {channels.map((channel) => (
        <ChannelCard
          key={channel.id}
          channel={channel}
          onClick={() => router.push(buildWatchHref(channel.id, watchContext))}
          actions={
            <FavoriteButton
              isActive={has(channel.id)}
              onToggle={() => toggle(channel.id)}
            />
          }
        />
      ))}
    </div>
  );
}
