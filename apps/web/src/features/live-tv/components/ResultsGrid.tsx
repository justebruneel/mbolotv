'use client';

import type { Channel } from '@mbolo/contracts';
import { VirtualChannelGrid } from './VirtualChannelGrid';
import { ChannelTile } from './ChannelTile';
import type { WatchContext } from '../utils';

const VIRTUALIZE_THRESHOLD = 500;

export function ResultsGrid({
  channels,
  total,
  watchContext,
}: {
  channels: Channel[];
  total?: number;
  watchContext?: WatchContext;
}) {
  if (channels.length > VIRTUALIZE_THRESHOLD) {
    return <VirtualChannelGrid channels={channels} total={total} watchContext={watchContext} />;
  }

  return (
    <div>
      {typeof total === 'number' && (
        <p className="text-sm text-muted mb-4">
          {total} chaîne{total > 1 ? 's' : ''} trouvée{total > 1 ? 's' : ''}
        </p>
      )}
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
        {channels.map((channel) => (
          <ChannelTile key={channel.id} channel={channel} watchContext={watchContext} />
        ))}
      </div>
    </div>
  );
}
