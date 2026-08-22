'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';

export interface TabItem {
  id: string;
  slug: string;
  label: string;
  count?: number;
}

function pillClass(variant: 'genre' | 'bouquet', isActive: boolean): string {
  if (variant === 'bouquet') {
    return [
      'px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors',
      isActive ? 'bg-accent text-on-accent' : 'bg-surface-2 text-muted border border-border hover:border-accent/60',
    ].join(' ');
  }
  return [
    'px-4 py-2 rounded-xl text-sm font-semibold whitespace-nowrap transition-all duration-200',
    isActive
      ? 'bg-accent text-on-accent shadow-md shadow-accent/20'
      : 'bg-surface-2 text-muted border border-border hover:border-accent/40 hover:text-foreground hover:bg-surface-3',
  ].join(' ');
}

export function ResponsiveTabs({
  items,
  activeSlug,
  onSelect,
  variant,
  moreLabel = 'Plus d’options',
  allLabel,
}: {
  items: TabItem[];
  activeSlug?: string;
  onSelect: (slug?: string) => void;
  variant: 'genre' | 'bouquet';
  moreLabel?: string;
  allLabel?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const widths = useRef<number[]>([]);
  const all = useMemoTabs(items, allLabel);
  const [visibleCount, setVisibleCount] = useState(Math.min(8, all.length));
  const [open, setOpen] = useState(false);
  const [, forceTick] = useState(0);

  useLayoutEffect(() => {
    const measure = measureRef.current;
    const container = containerRef.current;
    if (!measure || !container) return;
    const pills = Array.from(measure.children) as HTMLElement[];
    widths.current = pills.map((pill) => pill.getBoundingClientRect().width);
    const containerWidth = container.clientWidth;
    const gap = 8;
    const moreWidth = 124;
    let used = 0;
    let count = 0;
    for (let index = 0; index < widths.current.length; index += 1) {
      const projected = used + (count > 0 ? gap : 0) + widths.current[index] + moreWidth;
      if (projected > containerWidth && count > 0) break;
      used += (count > 0 ? gap : 0) + widths.current[index];
      count += 1;
    }
    setVisibleCount(Math.max(1, Math.min(count, all.length)));
  }, [all, forceTick]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => forceTick((value) => value + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (all.length === 0) return null;
  const hasMore = visibleCount < all.length;

  const handle = (slug: string): void => {
    onSelect(slug === '' ? undefined : slug);
    setOpen(false);
  };
  const isActive = (slug: string): boolean => (slug === '' ? activeSlug === undefined : activeSlug === slug);
  const renderPill = (item: TabItem): ReactElement => (
    <button key={item.id} type="button" className={pillClass(variant, isActive(item.slug))} onClick={() => handle(item.slug)}>
      {item.label}
      {variant === 'bouquet' && item.count ? <span className="opacity-60 ml-1">{item.count}</span> : null}
    </button>
  );

  return (
    <div className="relative">
      <div ref={containerRef} className="flex items-center gap-2 overflow-hidden">
        {all.slice(0, visibleCount).map(renderPill)}
        {hasMore && (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="shrink-0 rounded-xl border border-accent/40 bg-accent/10 px-4 py-2 text-sm font-semibold text-accent whitespace-nowrap hover:bg-accent/20"
          >
            {open ? 'Fermer' : moreLabel}
          </button>
        )}
      </div>

      {hasMore && open && (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {all.map(renderPill)}
        </div>
      )}

      <div ref={measureRef} className="pointer-events-none invisible absolute left-0 top-0 flex gap-2" aria-hidden>
        {all.map((item) => (
          <span key={item.id} className={pillClass(variant, false)}>
            {item.label}
            {variant === 'bouquet' && item.count ? <span className="opacity-60 ml-1">{item.count}</span> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function useMemoTabs(items: TabItem[], allLabel?: string): TabItem[] {
  if (!allLabel) return items;
  return [{ id: '__all', slug: '', label: allLabel }, ...items];
}
