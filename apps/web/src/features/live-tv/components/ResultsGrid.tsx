'use client';

import type { Channel } from '@mbolo/contracts';
import Link from 'next/link';
import { VirtualChannelGrid } from './VirtualChannelGrid';
import { ChannelTile } from './ChannelTile';
import { buildWatchHref, type WatchContext } from '../utils';

const VIRTUALIZE_THRESHOLD = 100;

export function ResultsGrid({
  channels,
  total,
  watchContext,
  highlightId,
  viewMode = 'grid',
}: {
  channels: Channel[];
  total?: number;
  watchContext?: WatchContext;
  highlightId?: string;
  viewMode?: 'grid' | 'list';
}) {
  if (viewMode === 'list') {
    return (
      <section aria-label="Résultats des chaînes — liste">
        <div className="mb-4 flex items-end justify-between gap-4">
          <p className="text-sm font-semibold text-secondary">
            {typeof total === 'number' ? `${total.toLocaleString('fr-FR')} chaîne${total > 1 ? 's' : ''}` : 'Chaînes'}
          </p>
        </div>
        <div className="space-y-2">
          {channels.map((channel) => (
            <Link
              key={channel.id}
              href={buildWatchHref(channel.id, watchContext)}
              className={`flex items-center gap-3 rounded-xl border bg-surface p-3 transition hover:border-accent/50 hover:shadow-sm ${channel.id === highlightId ? 'border-accent' : 'border-border'}`}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2">
                {channel.logoUrl ? (
                  <img src={channel.logoUrl} alt="" width={32} height={32} className="h-8 w-8 object-contain" loading="lazy" decoding="async" />
                ) : (
                  <span className="text-xs font-bold text-muted">{channel.name.slice(0, 2).toUpperCase()}</span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold leading-tight">{channel.name}</p>
                <p className="truncate text-xs text-muted">
                  {channel.nowPlaying ? `${channel.nowPlaying.title} · ${new Date(channel.nowPlaying.endsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : channel.country ?? 'Live'}
                </p>
              </div>
              {channel.nowPlaying && <span className="hidden shrink-0 rounded-full bg-danger/10 px-2 py-1 text-[10px] font-bold text-danger sm:inline-flex">DIRECT</span>}
              <span className="shrink-0 text-muted">›</span>
            </Link>
          ))}
        </div>
      </section>
    );
  }

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
