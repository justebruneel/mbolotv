'use client';

import { useWindowVirtualizer } from '@tanstack/react-virtual';
import type { Channel } from '@mbolo/contracts';
import { useLayoutEffect, useRef, useState } from 'react';
import { ChannelTile } from './ChannelTile';
import type { WatchContext } from '../utils';

const TILE_WIDTH = 208;
const GAP = 16;
const ROW_HEIGHT = 170;

export function VirtualChannelGrid({
  channels,
  total,
  watchContext,
}: {
  channels: Channel[];
  total?: number;
  watchContext?: WatchContext;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(8);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const compute = () => {
      setCols(Math.max(1, Math.floor((el.clientWidth + GAP) / (TILE_WIDTH + GAP))));
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rows = Math.ceil(channels.length / cols);
  const virtualizer = useWindowVirtualizer({
    count: rows,
    estimateSize: () => ROW_HEIGHT,
    overscan: 3,
  });
  const items = virtualizer.getVirtualItems();

  return (
    <div ref={containerRef}>
      {typeof total === 'number' && (
        <p className="text-sm text-muted mb-4">
          {total} chaîne{total > 1 ? 's' : ''} trouvée{total > 1 ? 's' : ''}
        </p>
      )}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {items.map((row) => {
          const start = row.index * cols;
          const rowChannels = channels.slice(start, start + cols);
          return (
            <div
              key={row.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${row.start}px)`,
                display: 'grid',
                gridTemplateColumns: `repeat(${cols}, ${TILE_WIDTH}px)`,
                gap: GAP,
              }}
            >
              {rowChannels.map((channel) => (
                <ChannelTile key={channel.id} channel={channel} watchContext={watchContext} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
