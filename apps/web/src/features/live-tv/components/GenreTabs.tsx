'use client';

import type { Category } from '@mbolo/contracts';
import { Skeleton } from '@mbolo/ui';
import { formatCategoryName } from '../utils';

export function GenreTabs({
  genres,
  active,
  onSelect,
  isLoading,
}: {
  genres: Category[];
  active?: string;
  onSelect: (slug?: string) => void;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex gap-2 overflow-hidden">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} width={110} height={34} className="rounded-full shrink-0" />
        ))}
      </div>
    );
  }

  const pill = (isActive: boolean): string =>
    [
      'px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors',
      isActive
        ? 'bg-accent text-on-accent'
        : 'bg-surface-2 text-muted border border-border hover:border-accent/60',
    ].join(' ');

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <button type="button" className={pill(active === undefined)} onClick={() => onSelect(undefined)}>
        Toutes
      </button>
      {genres.map((genre) => (
        <button
          key={genre.id}
          type="button"
          className={pill(active === genre.slug)}
          onClick={() => onSelect(genre.slug)}
        >
          {formatCategoryName(genre.name)}
        </button>
      ))}
    </div>
  );
}
