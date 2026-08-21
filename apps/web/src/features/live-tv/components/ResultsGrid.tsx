'use client';

import type { Channel } from '@mbolo/contracts';
import { VirtualChannelGrid } from './VirtualChannelGrid';
import { ChannelTile } from './ChannelTile';
import type { WatchContext } from '../utils';

const VIRTUALIZE_THRESHOLD = 500;

export function ResultsGrid({ channels, total, watchContext, highlightId }: { channels: Channel[]; total?: number; watchContext?: WatchContext; highlightId?: string }) {
  if (channels.length > VIRTUALIZE_THRESHOLD) {
    return <VirtualChannelGrid channels={channels} total={total} watchContext={watchContext} highlightId={highlightId} />;
  }

  return (
    <section aria-label="Résultats des chaînes">
      <div className="mb-6 flex items-end justify-between gap-4">
        <p className="text-sm font-semibold text-secondary">
          {typeof total === 'number'
            ? `${total.toLocaleString('fr-FR')} chaîne${total > 1 ? 's' : ''}`
            : 'Chaînes'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
        {channels.map((channel, index) => (
          <div
            key={channel.id}
            className="animate-scale-in"
            style={{ animationDelay: `${Math.min(index * 30, 300)}ms` }}
          >
            <ChannelTile channel={channel} watchContext={watchContext} highlight={channel.id === highlightId} />
          </div>
        ))}
      </div>
    </section>
  );
}
