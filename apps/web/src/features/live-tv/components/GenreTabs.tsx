'use client';

import type { Category } from '@mbolo/contracts';
import { Skeleton } from '@mbolo/ui';
import { useEffect, useMemo, useRef } from 'react';
import { formatCategoryName } from '../utils';

function genreSortKey(genre: Category): string {
  return formatCategoryName(genre.name).toLowerCase();
}

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
  const scrollRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(
    () => [...genres].sort((a, b) => genreSortKey(a).localeCompare(genreSortKey(b), 'fr')),
    [genres],
  );

  useEffect(() => {
    if (isLoading || !active) return;
    const container = scrollRef.current;
    if (!container) return;
    const timer = window.setTimeout(() => {
      const btn = container.querySelector<HTMLButtonElement>(`[data-slug="${active}"]`);
      btn?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [active, isLoading]);

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
    <div ref={scrollRef} className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <button
        type="button"
        className={pill(active === undefined)}
        onClick={() => onSelect(undefined)}
      >
        Toutes
      </button>
      {sorted.map((genre) => (
        <button
          key={genre.id}
          type="button"
          data-slug={genre.slug}
          className={pill(active === genre.slug)}
          onClick={() => onSelect(genre.slug)}
        >
          {formatCategoryName(genre.name)}
        </button>
      ))}
    </div>
  );
}
