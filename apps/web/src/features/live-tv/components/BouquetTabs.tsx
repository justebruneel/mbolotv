'use client';

import type { Category } from '@mbolo/contracts';
import { Skeleton } from '@mbolo/ui';
import { formatCategoryName } from '../utils';

export function BouquetTabs({
  bouquets,
  active,
  onSelect,
  isLoading,
}: {
  bouquets: Category[];
  active?: string;
  onSelect: (slug?: string) => void;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex gap-2 overflow-hidden">
        {Array.from({ length: 4 }).map((_, index) => (
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
        Tous les bouquets
      </button>
      {bouquets.map((bouquet) => (
        <button
          key={bouquet.id}
          type="button"
          className={pill(active === bouquet.slug)}
          onClick={() => onSelect(bouquet.slug)}
        >
          {formatCategoryName(bouquet.name)}
          <span className="opacity-60 ml-1">{bouquet.channelCount ?? ''}</span>
        </button>
      ))}
    </div>
  );
}
