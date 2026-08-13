'use client';

import { ChannelCard, FavoriteButton } from '@mbolo/ui';
import type { Channel } from '@mbolo/contracts';
import { useRouter } from 'next/navigation';
import { useFavoritesStore } from '../../../shared/stores/favorites';

export function ChannelGrid({ channels }: { channels: Channel[] }) {
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
          onClick={() => router.push(`/watch/${channel.id}`)}
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
