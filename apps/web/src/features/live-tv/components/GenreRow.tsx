'use client';

import type { Category, Channel } from '@mbolo/contracts';
import { Skeleton } from '@mbolo/ui';
import { ChannelTile } from './ChannelTile';
import { ChevronRightIcon } from './Icons';
import { formatCategoryName, type WatchContext } from '../utils';

export function GenreRow({
  category,
  channels,
  isLoading,
  onSeeAll,
  watchContext,
}: {
  category: Category;
  channels: Channel[];
  isLoading: boolean;
  onSeeAll: () => void;
  watchContext?: WatchContext;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted font-medium">Genre</p>
          <h2 className="text-lg font-bold text-foreground">
            {formatCategoryName(category.name)}{' '}
            <span className="text-muted font-normal text-sm">
              · {category.channelCount ?? channels.length}
            </span>
          </h2>
        </div>
        <button
          type="button"
          onClick={onSeeAll}
          className="flex items-center gap-1 text-sm text-muted hover:text-accent flex-shrink-0"
        >
          Voir tout <ChevronRightIcon size={16} />
        </button>
      </div>

      {isLoading ? (
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} width={128} height={128} className="rounded-xl shrink-0" />
          ))}
        </div>
      ) : channels.length > 0 ? (
        <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {channels.map((channel) => (
            <ChannelTile key={channel.id} channel={channel} watchContext={watchContext} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
