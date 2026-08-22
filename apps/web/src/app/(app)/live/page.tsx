'use client';

import { Button, Spinner } from '@mbolo/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useCategories, useInfiniteChannels } from '../../../shared/api/queries';
import { CategoryTree } from '../../../features/live-tv/components/CategoryTree';
import { ResponsiveTabs } from '../../../features/live-tv/components/ResponsiveTabs';
import { SearchIcon, XIcon } from '../../../features/live-tv/components/Icons';
import { ResultsGrid } from '../../../features/live-tv/components/ResultsGrid';
import { categoryLabel, formatCategoryName, isBouquetCategory } from '../../../features/live-tv/utils';

const PAGE_SIZE = 48;
const MAX_BOUQUETS = 24;
const SEARCH_DEBOUNCE_MS = 300;
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
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const [appliedQuery, setAppliedQuery] = useState(searchParams.get('q') ?? '');
  const [treeOpen, setTreeOpen] = useState(false);
  const deferredQuery = useDeferredValue(appliedQuery);

  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const urlQuery = searchParams.get('q') ?? '';
    if (urlQuery !== appliedQuery) {
      const params = new URLSearchParams(searchParams);
      if (appliedQuery.trim()) params.set('q', appliedQuery.trim());
      else params.delete('q');
      router.replace(params.toString() ? `/live?${params}` : '/live', { scroll: false });
    }
  }, [appliedQuery, router, searchParams]);

  const categoriesQuery = useCategories();
  const categories = categoriesQuery.data ?? [];
  const genres = useMemo(
    () => [...categories].sort((a, b) => formatCategoryName(a.name).localeCompare(formatCategoryName(b.name), 'fr')),
    [categories],
  );
  const bouquets = useMemo(
    () => categories.filter((bouquet) => isBouquetCategory(bouquet.name)).sort((a, b) => (b.channelCount ?? 0) - (a.channelCount ?? 0)).slice(0, MAX_BOUQUETS),
    [categories],
  );
  const isFiltering = category !== undefined || deferredQuery.trim() !== '';
  const channelsQuery = useInfiniteChannels({ category, q: deferredQuery.trim() || undefined }, PAGE_SIZE);
  const channels = channelsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = channelsQuery.data?.pages[0]?.total ?? 0;
  const selectedCategoryName = categoryLabel(categories, category);

  const resetAll = (): void => {
    setQuery('');
    setAppliedQuery('');
    router.replace('/live', { scroll: false });
  };
  const selectCategory = (slug?: string): void => {
    const params = new URLSearchParams(searchParams);
    if (slug) params.set('category', slug); else params.delete('category');
    router.replace(params.toString() ? `/live?${params}` : '/live', { scroll: false });
  };

  const contentReady = !channelsQuery.isLoading;
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

  useEffect(() => () => {
    sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
  }, []);

  const watchContext = { category, q: deferredQuery.trim() || undefined };

  return (
    <div className="min-h-screen animate-fade-in lg:flex">
      <aside className="hidden lg:block w-64 shrink-0 border-r border-border/60 p-3 overflow-y-auto lg:sticky lg:top-16 lg:h-[calc(100vh-4rem)]">
        <p className="px-2 pb-2 text-xs font-semibold uppercase tracking-widest text-muted">Catégories</p>
        <CategoryTree categories={categories} active={category} onSelect={selectCategory} />
      </aside>

      <div className="flex-1 min-w-0">
        {/* Search */}
        <div className="px-4 pt-4 animate-slide-up">
          <div className="relative max-w-lg">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted">
              <SearchIcon size={18} />
            </span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Rechercher une chaîne…"
              aria-label="Rechercher une chaîne"
              className="w-full rounded-xl border border-border bg-surface-2 pl-11 pr-4 py-3 text-sm font-medium placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition-all duration-200"
            />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(''); setAppliedQuery(''); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted hover:bg-surface-3 hover:text-foreground transition-colors"
                aria-label="Effacer la recherche"
              >
                <XIcon size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Genre tabs */}
        <div className="sticky top-14 z-20 border-b border-border bg-bg/85 backdrop-blur-xl px-4 py-3 mt-3 lg:top-0">
          <ResponsiveTabs
            items={genres.map((genre) => ({ id: genre.id, slug: genre.slug, label: formatCategoryName(genre.name) }))}
            activeSlug={category}
            onSelect={selectCategory}
            variant="genre"
            moreLabel="Plus d’options"
            allLabel="Toutes"
          />
        </div>

        {/* Bouquet tabs */}
        {bouquets.length > 0 && (
          <div className="px-4 py-2.5 border-b border-border/50">
            <ResponsiveTabs
              items={bouquets.map((bouquet) => ({ id: bouquet.id, slug: bouquet.slug, label: formatCategoryName(bouquet.name), count: bouquet.channelCount ?? 0 }))}
              activeSlug={category}
              onSelect={selectCategory}
              variant="bouquet"
              moreLabel="Plus d’options"
              allLabel="Tous les bouquets"
            />
          </div>
        )}

        {/* Actions bar */}
        <div className="px-4 py-3 flex flex-wrap items-center gap-2 border-b border-border/50">
          <button type="button" className="lg:hidden btn" onClick={() => setTreeOpen((open) => !open)}>
            {treeOpen ? 'Masquer les dossiers' : 'Dossiers'}
          </button>

          {selectedCategoryName && (
            <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-accent/10 border border-accent/30 text-xs font-medium text-accent animate-scale-in">
              {formatCategoryName(selectedCategoryName)}
              <button type="button" aria-label="Retirer le filtre de catégorie" onClick={() => selectCategory(undefined)} className="rounded-full p-0.5 hover:bg-accent/20 transition-colors">
                <XIcon size={12} />
              </button>
            </span>
          )}

          {isFiltering && (
            <button
              type="button"
              onClick={resetAll}
              className="ml-auto text-xs font-semibold text-muted hover:text-accent transition-colors"
            >
              Tout réinitialiser
            </button>
          )}
        </div>

        {treeOpen && (
          <div className="lg:hidden border-b border-border/50 px-4 py-3">
            <CategoryTree categories={categories} active={category} onSelect={selectCategory} />
          </div>
        )}

        {/* Channel grid */}
        <main className="px-4 py-8 space-y-8">
          {channelsQuery.isLoading ? (
            <div className="flex justify-center py-20">
              <Spinner />
            </div>
          ) : channels.length > 0 ? (
            <>
              <ResultsGrid channels={channels} total={total} watchContext={watchContext} highlightId={undefined} />
              {channelsQuery.hasNextPage ? (
                <div className="flex justify-center mt-8">
                  <Button
                    variant="primary"
                    onClick={() => channelsQuery.fetchNextPage()}
                    disabled={channelsQuery.isFetchingNextPage}
                    className="!px-8"
                  >
                    {channelsQuery.isFetchingNextPage ? 'Chargement…' : 'Charger plus de chaînes'}
                  </Button>
                </div>
              ) : (
                <p className="text-center text-muted text-sm mt-8">
                  {total} chaîne{total > 1 ? 's' : ''} affichée{total > 1 ? 's' : ''}
                </p>
              )}
            </>
          ) : (
            <div className="text-center py-20 animate-fade-in">
              <p className="text-foreground font-semibold text-lg">
                {isFiltering ? 'Aucune chaîne ne correspond à ces filtres.' : 'Aucune chaîne disponible.'}
              </p>
              {isFiltering && (
                <button
                  type="button"
                  onClick={resetAll}
                  className="mt-3 text-accent text-sm font-semibold hover:underline"
                >
                  Réinitialiser les filtres
                </button>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
