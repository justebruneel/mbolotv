'use client';

import { Button, Spinner } from '@mbolo/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  useCategories,
  useChannelRow,
  useCountries,
  useInfiniteChannels,
} from '../../../shared/api/queries';
import { FilterPanel } from '../../../features/live-tv/components/FilterPanel';
import { GenreRow } from '../../../features/live-tv/components/GenreRow';
import { GenreTabs } from '../../../features/live-tv/components/GenreTabs';
import { SearchIcon, SlidersIcon, XIcon } from '../../../features/live-tv/components/Icons';
import { ResultsGrid } from '../../../features/live-tv/components/ResultsGrid';
import { categoryLabel, formatCategoryName, isBouquetCategory } from '../../../features/live-tv/utils';

const PAGE_SIZE = 48;
const MAX_ROWS = 12;
const MAX_BOUQUETS = 24;
const MAX_TABS = 20;
const SCROLL_KEY = 'mbolo:live:scroll';

export default function LivePage() {
  return (
    <Suspense>
      <LiveContent />
    </Suspense>
  );
}

function LiveContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const category = searchParams.get('category') ?? undefined;
  const country = searchParams.get('country') ?? undefined;
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const [filterOpen, setFilterOpen] = useState(false);
  const deferredQuery = useDeferredValue(query);

  const categoriesQuery = useCategories();
  const countriesQuery = useCountries();

  const categories = categoriesQuery.data ?? [];
  const genres = useMemo(() => categories.filter((genre) => !isBouquetCategory(genre.name)), [categories]);
  const bouquets = useMemo(
    () =>
      categories
        .filter((bouquet) => isBouquetCategory(bouquet.name))
        .sort((a, b) => (b.channelCount ?? 0) - (a.channelCount ?? 0))
        .slice(0, MAX_BOUQUETS),
    [categories],
  );
  const tabCategories = useMemo(
    () =>
      [...categories]
        .sort((a, b) => (b.channelCount ?? 0) - (a.channelCount ?? 0))
        .slice(0, MAX_TABS),
    [categories],
  );

  const rowCategories = useMemo(() => {
    const list = [...genres, ...bouquets.filter((bouquet) => (bouquet.channelCount ?? 0) > 20)];
    return list.slice(0, MAX_ROWS);
  }, [genres, bouquets]);

  const isFiltering = category !== undefined || country !== undefined || deferredQuery.trim() !== '';

  const rowQueries = useMemo(() => {
    return Array.from({ length: MAX_ROWS }, (_, index) => rowCategories[index]);
  }, [rowCategories]);

  const rowHooks = rowQueries.map((rowCategory, index) =>
    useChannelRow(rowCategory?.slug, 24, !isFiltering && index < rowCategories.length),
  );

  const channelsQuery = useInfiniteChannels(
    {
      category,
      country,
      q: deferredQuery || undefined,
    },
    PAGE_SIZE,
  );

  const channels = channelsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = channelsQuery.data?.pages[0]?.total ?? 0;

  const activeFilterCount =
    (category !== undefined ? 1 : 0) + (country !== undefined ? 1 : 0) + (deferredQuery.trim() ? 1 : 0);

  const selectedCategoryName = categoryLabel(categories, category);
  const selectedCountryName = countriesQuery.data?.find((entry) => entry.slug === country)?.name;

  const resetAll = (): void => {
    setQuery('');
    setFilterOpen(false);
    const params = new URLSearchParams();
    router.replace(params.toString() ? `/live?${params}` : '/live', { scroll: false });
  };

  const selectCategory = (slug?: string): void => {
    const params = new URLSearchParams(searchParams);
    if (slug) params.set('category', slug);
    else params.delete('category');
    router.replace(params.toString() ? `/live?${params}` : '/live', { scroll: false });
  };

  const selectCountry = (slug?: string): void => {
    const params = new URLSearchParams(searchParams);
    if (slug && country !== slug) params.set('country', slug);
    else params.delete('country');
    router.replace(params.toString() ? `/live?${params}` : '/live', { scroll: false });
  };

  const selectBouquet = (slug: string): void => {
    const params = new URLSearchParams(searchParams);
    if (category === slug) params.delete('category');
    else params.set('category', slug);
    router.replace(params.toString() ? `/live?${params}` : '/live', { scroll: false });
  };

  const onQueryChange = (value: string): void => {
    setQuery(value);
    const params = new URLSearchParams(searchParams);
    if (value.trim()) params.set('q', value.trim());
    else params.delete('q');
    router.replace(params.toString() ? `/live?${params}` : '/live', { scroll: false });
  };

  const contentReady = !categoriesQuery.isLoading && (isFiltering ? !channelsQuery.isLoading : true);
  const savedScroll = useRef<number | null>(null);
  const restoredOnce = useRef(false);

  useEffect(() => {
    const raw = sessionStorage.getItem(SCROLL_KEY);
    if (raw == null) return;
    sessionStorage.removeItem(SCROLL_KEY);
    savedScroll.current = Number(raw);
  }, []);

  useEffect(() => {
    if (restoredOnce.current || savedScroll.current == null) return;
    const restore = () => {
      if (savedScroll.current != null) window.scrollTo(0, savedScroll.current);
    };
    if (contentReady) {
      restoredOnce.current = true;
      restore();
    } else {
      const timer = window.setTimeout(restore, 120);
      return () => window.clearTimeout(timer);
    }
  }, [contentReady]);

  useEffect(() => {
    return () => {
      sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
    };
  }, []);

  const watchContext = {
    category,
    country,
    q: deferredQuery.trim() || undefined,
  };

  const gridSlot = 'px-4';

  return (
    <div className="min-h-screen text-foreground">
      {/* Recherche */}
      <div className={`${gridSlot} pt-4`}>
        <div className="relative max-w-md">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">
            <SearchIcon size={16} />
          </span>
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Rechercher une chaîne…"
            className="w-full bg-surface-2 border border-border rounded-full pl-9 pr-4 py-2 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/60"
          />
        </div>
      </div>

      {/* Genres — une seule rangée, scroll horizontal */}
      <div className="sticky top-14 z-20 bg-bg border-b border-border px-4 py-3 mt-3 lg:top-0">
        <GenreTabs genres={tabCategories} active={category} onSelect={selectCategory} isLoading={categoriesQuery.isLoading} />
      </div>

      {/* Filtres — séparés des genres */}
      <div className="px-4 py-2.5 flex flex-wrap items-center gap-2 border-b border-border/60">
        <button
          type="button"
          onClick={() => setFilterOpen((open) => !open)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border bg-surface-2 text-sm font-medium text-foreground hover:border-accent/60"
        >
          <SlidersIcon size={14} />
          Filtres
          {activeFilterCount > 0 && (
            <span className="flex items-center justify-center h-5 w-5 rounded-full bg-accent text-xs font-bold text-on-accent">
              {activeFilterCount}
            </span>
          )}
        </button>

        {selectedCategoryName && (
          <span className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface-2 border border-border text-xs text-foreground">
            {formatCategoryName(selectedCategoryName)}
            <button type="button" aria-label="Retirer le filtre" onClick={() => selectCategory(undefined)}>
              <XIcon size={12} className="cursor-pointer hover:text-accent" />
            </button>
          </span>
        )}
        {selectedCountryName && (
          <span className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface-2 border border-border text-xs text-foreground">
            {selectedCountryName}
            <button type="button" aria-label="Retirer le filtre" onClick={() => selectCountry(undefined)}>
              <XIcon size={12} className="cursor-pointer hover:text-accent" />
            </button>
          </span>
        )}

        {isFiltering && (
          <button type="button" onClick={resetAll} className="ml-auto text-xs font-medium text-muted hover:text-accent">
            Réinitialiser
          </button>
        )}
      </div>

      {filterOpen && (
        <FilterPanel
          countries={countriesQuery.data ?? []}
          bouquets={bouquets}
          selectedCountry={country}
          selectedBouquet={isBouquetCategory(selectedCategoryName ?? '') ? category : undefined}
          onCountry={selectCountry}
          onBouquet={selectBouquet}
        />
      )}

      {/* Contenu */}
      <main className="px-4 py-6 space-y-8">
        {isFiltering ? (
          channelsQuery.isLoading ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : channels.length > 0 ? (
            <>
              <ResultsGrid channels={channels} total={total} watchContext={watchContext} />
              {channelsQuery.hasNextPage ? (
                <div className="flex justify-center mt-6">
                  <Button variant="primary" onClick={() => channelsQuery.fetchNextPage()} disabled={channelsQuery.isFetchingNextPage}>
                    {channelsQuery.isFetchingNextPage ? 'Chargement…' : 'Charger plus de chaînes'}
                  </Button>
                </div>
              ) : (
                <p className="text-center text-muted mt-6">{total} chaînes affichées</p>
              )}
            </>
          ) : (
            <div className="text-center py-16">
              <p className="text-foreground font-medium">Aucune chaîne ne correspond à ces filtres.</p>
              <button type="button" onClick={resetAll} className="mt-2 text-accent text-sm font-medium hover:underline">
                Réinitialiser les filtres
              </button>
            </div>
          )
        ) : categoriesQuery.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : (
          rowCategories.map((rowCategory, index) => (
            <GenreRow
              key={rowCategory.id}
              category={rowCategory}
              channels={rowHooks[index]?.data?.items ?? []}
              isLoading={rowHooks[index]?.isLoading ?? false}
              onSeeAll={() => selectCategory(rowCategory.slug)}
              watchContext={{ category: rowCategory.slug }}
            />
          ))
        )}
      </main>
    </div>
  );
}
