'use client';

import type { Channel } from '@mbolo/contracts';
import { VirtualChannelGrid } from './VirtualChannelGrid';
import { ChannelTile } from './ChannelTile';
import type { WatchContext } from '../utils';

const VIRTUALIZE_THRESHOLD = 500;
export function ResultsGrid({ channels, total, watchContext }: { channels: Channel[]; total?: number; watchContext?: WatchContext }) {
  if (channels.length > VIRTUALIZE_THRESHOLD) return <VirtualChannelGrid channels={channels} total={total} watchContext={watchContext} />;
  return <section aria-label="Résultats des chaînes"><div className="mb-5 flex items-end justify-between gap-4"><p className="text-sm font-medium text-muted">{typeof total === 'number' ? `${total.toLocaleString('fr-FR')} chaîne${total > 1 ? 's' : ''}` : 'Chaînes'}</p></div><div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-5 gap-y-8 sm:grid-cols-[repeat(auto-fit,minmax(170px,1fr))] lg:grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">{channels.map((channel) => <ChannelTile key={channel.id} channel={channel} watchContext={watchContext} />)}</div></section>;
}
