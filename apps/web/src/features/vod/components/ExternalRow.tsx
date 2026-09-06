'use client';

import { Icon } from '@mbolo/ui';
import type { ExternalTitlePublic } from '@mbolo/contracts';
import Link from 'next/link';
import { useEffect } from 'react';
import { useRowPager } from './VodRow';
import { ExternalTile } from './ExternalTile';

// Rail horizontal des titres externes — même coquille que VodRow/YoutubeRow :
// titre + « Voir tout », flèches desktop, swipe natif. Silencieux si vide.
export function ExternalRow({ title, items, seeAllHref, onSeeAll }: {
  title: string;
  items: ExternalTitlePublic[];
  // État local (pas d'URL) : onSeeAll prioritaire sur seeAllHref.
  seeAllHref?: string;
  onSeeAll?: () => void;
}) {
  const { scrollerRef, atStart, atEnd, scrollByPage, updateArrows } = useRowPager();

  useEffect(() => {
    updateArrows();
  }, [updateArrows, items.length]);

  if (items.length === 0) return null;

  return (
    <section className="group/row mb-7">
      <div className="mb-2.5 flex items-baseline justify-between gap-3 px-0.5">
        <h2 className="text-base font-bold tracking-tight md:text-lg">{title}</h2>
        {onSeeAll ? (
          <button type="button" onClick={onSeeAll} className="flex items-center gap-1 text-xs font-semibold text-muted opacity-0 transition-opacity hover:text-accent group-hover/row:opacity-100 max-md:opacity-100">
            Voir tout <Icon.ChevronRight size={14} />
          </button>
        ) : seeAllHref ? (
          <Link href={seeAllHref} className="flex items-center gap-1 text-xs font-semibold text-muted opacity-0 transition-opacity hover:text-accent group-hover/row:opacity-100 max-md:opacity-100">
            Voir tout <Icon.ChevronRight size={14} />
          </Link>
        ) : null}
      </div>
      <div className="relative">
        {!atStart && (
          <button type="button" aria-label="Défiler vers la gauche" onClick={() => scrollByPage(-1)}
            className="absolute left-0 top-1/2 z-10 flex h-16 w-8 -translate-y-1/2 items-center justify-center rounded-r-lg bg-black/60 text-white opacity-0 backdrop-blur transition-opacity hover:bg-black/80 group-hover/row:opacity-100 max-md:hidden">
            <Icon.ChevronLeft size={20} />
          </button>
        )}
        <div ref={scrollerRef} onScroll={updateArrows}
          className="flex snap-x snap-mandatory gap-2.5 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {items.map((item) => (
            <div key={item.id} className="w-[136px] shrink-0 snap-start sm:w-[156px]">
              <ExternalTile item={item} />
            </div>
          ))}
        </div>
        {!atEnd && (
          <button type="button" aria-label="Défiler vers la droite" onClick={() => scrollByPage(1)}
            className="absolute right-0 top-1/2 z-10 flex h-16 w-8 -translate-y-1/2 items-center justify-center rounded-l-lg bg-black/60 text-white opacity-0 backdrop-blur transition-opacity hover:bg-black/80 group-hover/row:opacity-100 max-md:hidden">
            <Icon.ChevronRight size={20} />
          </button>
        )}
      </div>
    </section>
  );
}
