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
          <Skeleton key={index} width={110} height={36} className="rounded-xl shrink-0" />
        ))}
      </div>
    );
  }

  const pill = (isActive: boolean): string =>
    [
      'px-4 py-2 rounded-xl text-sm font-semibold whitespace-nowrap transition-all duration-200',
      isActive
        ? 'bg-accent text-on-accent shadow-md shadow-accent/20'
        : 'bg-surface-2 text-muted border border-border hover:border-accent/40 hover:text-foreground hover:bg-surface-3',
    ].join(' ');

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <button
        type="button"
        className={pill(active === undefined)}
        onClick={() => onSelect(undefined)}
      >
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
