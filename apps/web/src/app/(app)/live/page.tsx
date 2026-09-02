'use client';

import type { Channel, Match } from '@mbolo/contracts';
import { Icon, MatchCard, Spinner } from '@mbolo/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense, useDeferredValue, useEffect, useMemo, useRef } from 'react';
import { useCategories, useFavorites, useInfiniteChannels, useMatches } from '../../../shared/api/queries';
import { FeaturedAuto } from '../../../features/live-tv/components/FeaturedAuto';
import { FootballFeatured } from '../../../features/live-tv/components/FootballFeatured';
import { NetflixRow } from '../../../features/live-tv/components/NetflixRow';
import { ResultsGrid } from '../../../features/live-tv/components/ResultsGrid';
import { useRecommendations } from '../../../features/live-tv/hooks/useRecommendations';
import { useSettingsStore } from '../../../shared/stores/settings';
import { categoryLabel, formatCategoryName } from '../../../features/live-tv/utils';
import { useQueries } from '@tanstack/react-query';
import { apiGet } from '../../../shared/api/client';

const PAGE_SIZE = 48;

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
    <BrowseView />
  ) : (
    <HomeView />
  );
}

/* ============================== ACCUEIL NETFLIX ============================== */

function HomeView() {
  const channelsQuery = useInfiniteChannels({}, PAGE_SIZE);
  const categoriesQuery = useCategories();
  const liveMatchesQuery = useMatches('LIVE');

  // Pool de chaînes : première page (48) suffit pour hero + rangées ;
  // NetflixRow charge chaque dossier en lazy, pas besoin de précharger 96.
  const pool = useMemo(
    () => channelsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [channelsQuery.data],
  );
  useEffect(() => {
    if (channelsQuery.hasNextPage && pool.length < 48 && !channelsQuery.isFetchingNextPage) {
      void channelsQuery.fetchNextPage();
    }
  }, [channelsQuery, pool.length]);

  const nowPlayingRow = useMemo(() => pool.filter((channel) => channel.nowPlaying).slice(0, 24), [pool]);

  const categories = categoriesQuery.data ?? [];
  // Toutes les rangées de dossiers autorisés, classées par audience. Les
  // troncatures précédentes (top 6 bouquets / top 8 genres) cachaient la
  // majorité du catalogue ; NetflixRow chargeant paresseusement à l'entrée
  // dans le viewport, afficher l'intégralité ne coûte aucune requête upfront.
  const categoryRows = useMemo(
    () => [...categories].sort((a, b) => (b.channelCount ?? 0) - (a.channelCount ?? 0)),
    [categories],
  );

  // Reprendre : même si 0 favoris, affiche les dernières chaînes vues (lastWatched)
  const continueChannels = useContinueChannels();

  // Personnalisation : pays le plus regardé + suggestions par habitudes.
  const recommendations = useRecommendations();

  const liveMatches = (liveMatchesQuery.data?.items ?? []).filter((match) => match.state === 'LIVE').slice(0, 12);
  // Dernière chaîne vue : sa carte est surlignée et recentrée dans sa rangée
  // au retour depuis le lecteur.
  const highlightId = useSettingsStore((state) => state.lastWatched[0]?.channelId);

  // Favoris : liste serveur de l'appareil (les plus récemment ajoutés d'abord).
  const favChannels = useFavorites().data?.items ?? [];

  if (channelsQuery.isLoading && pool.length === 0) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <main className="pb-16">
      <div className="space-y-9 pt-6 md:pt-8">
        <FeaturedAuto />

        <FootballFeatured />

        {continueChannels.length > 0 && <NetflixRow title="Reprendre" subtitle="Continuer à regarder" channels={continueChannels} highlightId={highlightId} />}

        {nowPlayingRow.length >= 4 && <NetflixRow title="Programmes en cours" channels={nowPlayingRow} highlightId={highlightId} />}

        {favChannels.length > 0 && <NetflixRow title="Mes favoris" channels={favChannels} seeAllHref="/favorites" highlightId={highlightId} />}

        {recommendations.countryRow.length >= 4 && (
          <NetflixRow
            title={
              recommendations.countrySource === 'geo'
                ? 'Chaînes locales'
                : recommendations.countryCode
                  ? `Chaînes · ${recommendations.countryCode}`
                  : 'Chaînes de chez toi'
            }
            subtitle={recommendations.countrySource === 'geo' ? 'Mis en avant pour votre pays' : 'Votre pays'}
            channels={recommendations.countryRow}
            highlightId={highlightId}
          />
        )}

        {recommendations.forYou.length >= 4 && <NetflixRow title="Recommandés pour toi" channels={recommendations.forYou} highlightId={highlightId} />}

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

        {categoryRows.map((category) => (
          <NetflixRow
            key={category.id}
            title={formatCategoryName(category.name)}
            subtitle={`${category.channelCount ?? 0}`}
            slug={category.slug}
            seeAllHref={`/live?category=${category.slug}`}
            highlightId={highlightId}
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

function useContinueChannels(): Channel[] {
  const lastWatched = useSettingsStore((state) => state.lastWatched);
  const ids = useMemo(() => lastWatched.map((entry) => entry.channelId).slice(0, 12), [lastWatched]);
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['channel', id],
      queryFn: () => apiGet<Channel>(`/channels/${id}`),
      staleTime: 5 * 60_000,
      enabled: ids.length > 0,
    })),
  });
  return useMemo(() => {
    if (ids.length === 0) return [];
    const map = new Map<string, Channel>();
    results.forEach((result) => {
      const ch = result.data;
      if (ch) map.set(ch.id, ch);
    });
    // Conserve l'ordre de lastWatched
    return ids.map((id) => map.get(id)).filter((ch): ch is Channel => Boolean(ch));
  }, [ids, results.map((r) => r.dataUpdatedAt).join(',')]);
}

/* ============================ VUE TOUT PARCOURIR ============================ */

function BrowseView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const category = searchParams.get('category') ?? undefined;
  // q est piloté par HeaderSearch (débouncé dans l'URL) : lecture directe.
  const rawQuery = searchParams.get('q') ?? '';
  const deferredQuery = useDeferredValue(rawQuery);
  const categoriesQuery = useCategories();
  const categories = categoriesQuery.data ?? [];
  const selectedCategoryName = categoryLabel(categories, category);

  const isFiltering = Boolean(deferredQuery.trim());
  const channelsQuery = useInfiniteChannels({ category, q: deferredQuery.trim() || undefined }, PAGE_SIZE);
  const channels = channelsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = channelsQuery.data ? (channelsQuery.data.pages[channelsQuery.data.pages.length - 1]?.total ?? channelsQuery.data.pages[0]?.total ?? 0) : 0;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const topCategories = useMemo(
    () => [...categories].sort((a, b) => (b.channelCount ?? 0) - (a.channelCount ?? 0)).slice(0, 12),
    [categories],
  );
  const viewMode = useSettingsStore((state) => state.browseViewMode);
  const setViewMode = useSettingsStore((state) => state.setBrowseViewMode);
  // Dernière chaîne vue : surlignée au retour pour se reperer dans la liste.
  const lastWatched = useSettingsStore((state) => state.lastWatched);
  const highlightId = lastWatched[0]?.channelId;

  const setCategory = (slug?: string): void => {
    const params = new URLSearchParams(searchParams);
    if (slug) params.set('category', slug);
    else params.delete('category');
    router.replace(params.toString() ? `/live?${params}` : '/live', { scroll: false });
  };

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    if (!channelsQuery.hasNextPage || channelsQuery.isFetchingNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && channelsQuery.hasNextPage && !channelsQuery.isFetchingNextPage) {
          void channelsQuery.fetchNextPage();
        }
      },
      { rootMargin: '600px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [channelsQuery.hasNextPage, channelsQuery.isFetchingNextPage, channelsQuery.fetchNextPage, channels.length]);

  const isSwitching = channelsQuery.isFetching && !channelsQuery.isLoading;

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
          <div className="flex items-center gap-2">
            {isFiltering && (
              <button type="button" onClick={clearSearch} className="text-xs font-semibold text-muted hover:text-accent">
                Effacer « {deferredQuery.trim()} » ✕
              </button>
            )}
            <div className="flex items-center gap-1 rounded-full border border-border bg-surface p-1">
              <button
                type="button"
                aria-label="Vue grille"
                aria-pressed={viewMode === 'grid'}
                onClick={() => setViewMode('grid')}
                className={`inline-flex h-7 w-7 items-center justify-center rounded-full transition ${viewMode === 'grid' ? 'bg-foreground text-bg' : 'text-muted hover:text-foreground'}`}
              >
                <Icon.LayoutDashboard size={14} aria-hidden />
              </button>
              <button
                type="button"
                aria-label="Vue liste"
                aria-pressed={viewMode === 'list'}
                onClick={() => setViewMode('list')}
                className={`inline-flex h-7 w-7 items-center justify-center rounded-full transition ${viewMode === 'list' ? 'bg-foreground text-bg' : 'text-muted hover:text-foreground'}`}
              >
                <Icon.ListFilter size={14} aria-hidden />
              </button>
            </div>
          </div>
        </div>
        {topCategories.length > 0 && (
          <div className="mt-4 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button
              type="button"
              onClick={() => setCategory(undefined)}
              className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-bold transition ${!category ? 'border-accent bg-accent text-on-accent' : 'border-border bg-surface hover:bg-surface-2'}`}
            >
              Toutes
            </button>
            {topCategories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setCategory(cat.slug)}
                className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-bold transition ${category === cat.slug ? 'border-accent bg-accent text-on-accent' : 'border-border bg-surface hover:bg-surface-2'}`}
              >
                {formatCategoryName(cat.name)} · {cat.channelCount ?? 0}
              </button>
            ))}
          </div>
        )}
      </div>

      <main className="mx-auto max-w-[1600px] px-4 py-6 md:px-10">
        {channelsQuery.isLoading && channels.length === 0 ? (
          <div className="flex justify-center py-20"><Spinner /></div>
        ) : channels.length > 0 ? (
          <div className={isSwitching ? 'opacity-60 transition-opacity' : ''} aria-live="polite" aria-busy={isSwitching}>
            <ResultsGrid
              channels={channels}
              total={total}
              watchContext={{ category, q: deferredQuery.trim() || undefined }}
              viewMode={viewMode}
              highlightId={highlightId}
            />
            <div ref={sentinelRef} className="mt-8 flex justify-center py-4">
              {channelsQuery.hasNextPage ? (
                channelsQuery.isFetchingNextPage ? (
                  <span className="inline-flex items-center gap-2 text-sm text-muted">
                    <Spinner /> Chargement…
                  </span>
                ) : (
                  <span className="text-xs text-muted">Défilez pour charger plus</span>
                )
              ) : (
                <span className="text-xs text-faint">{total > 0 ? `— Fin du catalogue (${total.toLocaleString('fr-FR')} chaînes) —` : ''}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="py-20 text-center animate-fade-in">
            <p className="font-semibold text-foreground">{isFiltering ? `Aucun résultat pour « ${deferredQuery.trim()} ».` : 'Aucune chaîne disponible.'}</p>
            {isFiltering ? (
              <button type="button" onClick={clearSearch} className="mt-3 text-accent text-sm font-semibold hover:underline">
                Effacer la recherche
              </button>
            ) : null}
            {topCategories.length > 0 && (
              <div className="mx-auto mt-6 max-w-md">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">Essayez ces dossiers populaires</p>
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  {topCategories.slice(0, 3).map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setCategory(cat.slug)}
                      className="rounded-full border border-border bg-surface px-3.5 py-1.5 text-xs font-bold hover:bg-surface-2 transition"
                    >
                      {formatCategoryName(cat.name)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
