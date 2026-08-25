'use client';

import type { Channel, Match } from '@mbolo/contracts';
import { Button, MatchCard, Spinner } from '@mbolo/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense, useDeferredValue, useEffect, useMemo } from 'react';
import { useCategories, useInfiniteChannels, useMatches } from '../../../shared/api/queries';
import { HeroBanner } from '../../../features/live-tv/components/HeroBanner';
import { NetflixRow } from '../../../features/live-tv/components/NetflixRow';
import { ResultsGrid } from '../../../features/live-tv/components/ResultsGrid';
import { useFavoritesStore } from '../../../shared/stores/favorites';
import { categoryLabel, formatCategoryName, isBouquetCategory } from '../../../features/live-tv/utils';

const PAGE_SIZE = 48;
const HERO_CANDIDATES = 5;
const ROW_CATEGORIES = 8;
const ROW_BOUQUETS = 6;

export default function LivePage() {
  return (
    <Suspense>
      <LiveContent />
    </Suspense>
  );
}

function LiveContent() {
  const searchParams = useSearchParams();
  const category = searchParams.get('category') ?? undefined;
  const query = searchParams.get('q') ?? '';
  const browseMode = Boolean(category) || query.trim().length > 0;

  return browseMode ? (
    <BrowseView initialQuery={query} />
  ) : (
    <HomeView />
  );
}

/* ============================== ACCUEIL NETFLIX ============================== */

function HomeView() {
  const channelsQuery = useInfiniteChannels({}, PAGE_SIZE);
  const categoriesQuery = useCategories();
  const liveMatchesQuery = useMatches('LIVE');
  const favoritesIds = useFavoritesStore((state) => state.ids);

  // Pool de chaînes : première page + remplissage jusqu'à ~96 pour alimenter
  // hero et rangées sans requêtes supplémentaires.
  const pool = useMemo(
    () => channelsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [channelsQuery.data],
  );
  useEffect(() => {
    if (channelsQuery.hasNextPage && pool.length < 96 && !channelsQuery.isFetchingNextPage) {
      void channelsQuery.fetchNextPage();
    }
  }, [channelsQuery, pool.length]);

  const featured = useMemo(() => {
    const withVisual = pool.filter((channel) => channel.nowPlaying?.imageUrl || channel.logoUrl);
    if (withVisual.length >= 1) return withVisual.slice(0, HERO_CANDIDATES);
    return pool.slice(0, HERO_CANDIDATES);
  }, [pool]);

  const nowPlayingRow = useMemo(() => pool.filter((channel) => channel.nowPlaying).slice(0, 24), [pool]);

  const categories = categoriesQuery.data ?? [];
  const bouquets = useMemo(
    () =>
      categories
        .filter((category) => isBouquetCategory(category.name))
        .sort((a, b) => (b.channelCount ?? 0) - (a.channelCount ?? 0))
        .slice(0, ROW_BOUQUETS),
    [categories],
  );
  const topGenres = useMemo(
    () =>
      categories
        .filter((category) => !isBouquetCategory(category.name))
        .sort((a, b) => (b.channelCount ?? 0) - (a.channelCount ?? 0))
        .slice(0, ROW_CATEGORIES),
    [categories],
  );

  // Favoris : une requête large cachée, filtrée par les ids du store.
  const favChannels = useFavoriteChannels(favoritesIds);

  const liveMatches = (liveMatchesQuery.data?.items ?? []).filter((match) => match.state === 'LIVE').slice(0, 12);

  if (channelsQuery.isLoading && pool.length === 0) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <main className="pb-16">
      <HeroBanner channels={featured} />

      <div className="relative z-10 -mt-6 space-y-9 md:-mt-10">
        {nowPlayingRow.length >= 4 && <NetflixRow title="Programmes en cours" channels={nowPlayingRow} />}

        {favChannels.length > 0 && <NetflixRow title="Mes favoris" channels={favChannels} seeAllHref="/favorites" />}

        {liveMatches.length > 0 && (
          <section className="group/row relative">
            <h2 className="mb-2.5 px-4 text-base font-bold text-foreground md:px-10 md:text-lg">Sport en direct</h2>
            <div className="flex snap-x gap-3 overflow-x-auto px-4 pb-4 md:gap-4 md:px-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {liveMatches.map((match) => (
                <MatchLink key={match.id} match={match} />
              ))}
            </div>
          </section>
        )}

        {bouquets.map((bouquet) => (
          <NetflixRow
            key={bouquet.id}
            title={formatCategoryName(bouquet.name)}
            subtitle={`${bouquet.channelCount ?? 0}`}
            slug={bouquet.slug}
            seeAllHref={`/live?category=${bouquet.slug}`}
          />
        ))}

        {topGenres.map((genre) => (
          <NetflixRow
            key={genre.id}
            title={formatCategoryName(genre.name)}
            subtitle={`${genre.channelCount ?? 0}`}
            slug={genre.slug}
            seeAllHref={`/live?category=${genre.slug}`}
          />
        ))}

        {pool.length === 0 && !channelsQuery.isLoading && (
          <p className="px-6 py-20 text-center text-sm text-muted">Aucune chaîne disponible pour le moment.</p>
        )}
      </div>
    </main>
  );
}


function MatchLink({ match }: { match: Match }) {
  const firstChannel = match.channels?.[0];
  return (
    <div className="shrink-0 snap-start">
      <MatchLinkInner match={match} channelId={firstChannel?.id} />
    </div>
  );
}

function MatchLinkInner({ match, channelId }: { match: Match; channelId?: string }) {
  if (!channelId) return <MatchCard match={match} />;
  return (
    <Link href={`/watch/${channelId}`} className="block" aria-label={`Regarder ${match.homeTeam} vs ${match.awayTeam}`}>
      <MatchCard match={match} />
    </Link>
  );
}

// Rangée de favoris : une seule requête large mise en cache, filtrée localement.
function useFavoriteChannels(favoriteIds: string[]): Channel[] {
  const wideQuery = useInfiniteChannels({}, 200);
  return useMemo(() => {
    if (favoriteIds.length === 0) return [];
    const wanted = new Set(favoriteIds);
    const all = wideQuery.data?.pages.flatMap((page) => page.items) ?? [];
    return all.filter((channel) => wanted.has(channel.id)).slice(0, 24);
  }, [favoriteIds, wideQuery.data]);
}

/* ============================ VUE TOUT PARCOURIR ============================ */

function BrowseView({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const category = searchParams.get('category') ?? undefined;
  const deferredQuery = useDeferredValue(initialQuery);
  const categoriesQuery = useCategories();
  const categories = categoriesQuery.data ?? [];
  const selectedCategoryName = categoryLabel(categories, category);

  const isFiltering = Boolean(deferredQuery.trim());
  const channelsQuery = useInfiniteChannels({ category, q: deferredQuery.trim() || undefined }, PAGE_SIZE);
  const channels = channelsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = channelsQuery.data?.pages[0]?.total ?? 0;

  const clearSearch = (): void => {
    const params = new URLSearchParams(searchParams);
    params.delete('q');
    router.replace(params.toString() ? `/live?${params}` : '/live', { scroll: false });
  };

  return (
    <div className="min-h-screen animate-fade-in">
      <div className="mx-auto max-w-[1600px] px-4 pt-6 md:px-10">
        <Link href="/live" className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted transition-colors hover:text-accent">
          ← Retour à l'accueil
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-xl font-black tracking-tight md:text-2xl">
            {selectedCategoryName ? formatCategoryName(selectedCategoryName) : 'Tout le catalogue'}
            <span className="ml-2 text-sm font-normal text-muted">{total.toLocaleString('fr-FR')} chaîne{total > 1 ? 's' : ''}</span>
          </h1>
          {isFiltering && (
            <button type="button" onClick={clearSearch} className="text-xs font-semibold text-muted hover:text-accent">
              Effacer « {deferredQuery.trim()} » ✕
            </button>
          )}
        </div>
      </div>

      <main className="mx-auto max-w-[1600px] px-4 py-6 md:px-10">
        {channelsQuery.isLoading ? (
          <div className="flex justify-center py-20"><Spinner /></div>
        ) : channels.length > 0 ? (
          <>
            <ResultsGrid channels={channels} total={total} watchContext={{ category, q: deferredQuery.trim() || undefined }} />
            {channelsQuery.hasNextPage && (
              <div className="mt-8 flex justify-center">
                <Button variant="primary" onClick={() => channelsQuery.fetchNextPage()} disabled={channelsQuery.isFetchingNextPage} className="!px-8">
                  {channelsQuery.isFetchingNextPage ? 'Chargement…' : 'Charger plus'}
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="py-20 text-center animate-fade-in">
            <p className="font-semibold text-foreground">{isFiltering ? `Aucun résultat pour « ${deferredQuery.trim()} ».` : 'Aucune chaîne disponible.'}</p>
            {isFiltering && (
              <button type="button" onClick={clearSearch} className="mt-3 text-accent text-sm font-semibold hover:underline">Effacer la recherche</button>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
