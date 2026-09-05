'use client';

import { Icon } from '@mbolo/ui';
import type { VodItem } from '@mbolo/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { VodTile } from './VodTile';

// Rangée horizontale façon Netflix : titre + flèches défilantes (visibles
// au survol desktop, toujours utiles au doigt via le swipe natif). Le
// défilement glisse par page (≈ 85 % de la largeur visible) plutôt que par
// carte. « Voir tout » mène à la grille filtrée sur la catégorie.
// Coquille commune des rails horizontaux : refs + état des flèches +
// saut de page (≈ 85 % de la largeur visible). `updateArrows` doit être
// rappelé par l'appelant quand le contenu change (le ResizeObserver ne voit
// que la boîte de l'élément, pas la croissance de son scrollWidth).
export function useRowPager() {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const updateArrows = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const nextStart = el.scrollLeft <= 8;
    const nextEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8;
    setAtStart((prev) => (prev === nextStart ? prev : nextStart));
    setAtEnd((prev) => (prev === nextEnd ? prev : nextEnd));
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateArrows);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateArrows]);

  function scrollByPage(direction: 1 | -1): void {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.round(el.clientWidth * 0.85), behavior: 'smooth' });
  }

  return { scrollerRef, atStart, atEnd, scrollByPage, updateArrows };
}

export function VodRow({ title, count, items, seeAllKind, seeAllCategory, seeAllHref }: {
  title: string;
  count?: number | null;
  items: VodItem[];
  seeAllKind?: 'MOVIE' | 'SERIES';
  seeAllCategory?: string;
  // Prioritaire sur le couple kind/category : les rails « dossier » pointent
  // vers /vod?dossier=<slug> (les catégories sont réservées au catalogue brut).
  seeAllHref?: string;
}) {
  const { scrollerRef, atStart, atEnd, scrollByPage, updateArrows } = useRowPager();

  useEffect(() => {
    updateArrows();
  }, [updateArrows, items.length]);

  if (items.length === 0) return null;
  const params = new URLSearchParams({ kind: seeAllKind ?? 'MOVIE' });
  if (seeAllCategory) params.set('category', seeAllCategory);
  const href = seeAllHref ?? `/vod?${params.toString()}`;

  return (
    <section className="group/row mb-7">
      <div className="mb-2.5 flex items-baseline justify-between gap-3 px-0.5">
        <h2 className="text-base font-bold tracking-tight md:text-lg">
          {title}
          {typeof count === 'number' && count > 0 && <span className="ml-2 text-xs font-medium text-muted">{count} titres</span>}
        </h2>
        <Link href={href} className="flex items-center gap-1 text-xs font-semibold text-muted opacity-0 transition-opacity hover:text-accent group-hover/row:opacity-100 max-md:opacity-100">
          Voir tout <Icon.ChevronRight size={14} />
        </Link>
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
            <div key={item.id} className="w-[136px] shrink-0 snap-start sm:w-[152px]">
              <VodTile item={item} />
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
