'use client';

import { EmptyState, Spinner } from '@mbolo/ui';
import type { VodKind } from '@mbolo/contracts';
import { useEffect } from 'react';
import {
  useInfiniteExternalTitles,
  useInfiniteMergedYoutube,
  useInfiniteVod,
  useInfiniteVodFolderItems,
  useInfiniteYoutube,
} from '../../../../shared/api/queries';
import { useInfiniteScroll } from '../../../../shared/hooks/useInfiniteScroll';
import { PAGE_SIZE, dedupeYoutubeItems } from '../../vodUtils';
import { RetryButton } from '../RetryButton';
import { SkeletonPosterGrid, SkeletonVideoGrid } from '../Skeletons';
import { VodTile } from '../VodTile';
import { ExternalTile } from '../ExternalTile';
import { YoutubeTile } from '../YoutubeTile';

// Signale au parent (recherche unifiée) qu'une section a répondu, vide ou
// non. Idempotent : marquer la même valeur ne re-render pas (le parent garde
// prev si rien ne change).
export function useSectionSettled(onSettled: ((empty: boolean) => void) | undefined, settled: boolean, empty: boolean): void {
  useEffect(() => {
    if (settled) onSettled?.(empty);
  }, [onSettled, settled, empty]);
}

// Grille « tout le catalogue » (défilement infini), filtrée par type,
// catégorie et recherche serveur.
export function VodBrowse({ kind, category, q, hideWhenEmpty = false, onSettled }: { kind: VodKind; category: string | null; q: string; hideWhenEmpty?: boolean; onSettled?: (empty: boolean) => void }) {
  const query = useInfiniteVod({ kind, category: category ?? undefined, q: q || undefined }, PAGE_SIZE);
  const { sentinelRef, isFetchingNextPage } = useInfiniteScroll(query);

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  useSectionSettled(onSettled, !query.isLoading && !query.isPlaceholderData, query.isError || items.length === 0);

  if (query.isLoading) return <SkeletonPosterGrid />;
  if (query.isError) return hideWhenEmpty ? null : (
    <EmptyState title="Catalogue indisponible" hint="Réessayez dans quelques instants." action={<RetryButton onRetry={() => void query.refetch()} />} />
  );
  if (items.length === 0) return hideWhenEmpty ? null : <EmptyState title="Aucun résultat" hint={q ? `Aucun titre ne correspond à « ${q} ».` : 'Ce catalogue est vide pour le moment.'} />;

  return (
    <>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {items.map((item) => <VodTile key={item.id} item={item} />)}
      </div>
      <div ref={sentinelRef} className="h-10" />
      {isFetchingNextPage && <div className="flex justify-center py-4"><Spinner /></div>}
    </>
  );
}

// Grille « dans ce dossier » : items règles ∪ manuel, défilement infini.
// hideWhenEmpty : quand le dossier a des chaînes YouTube, une grille vide ou
// en erreur se retire silencieusement — les sections YouTube portent la page.
export function FolderVodBrowse({ slug, q, hideWhenEmpty = false }: { slug: string; q: string; hideWhenEmpty?: boolean }) {
  const query = useInfiniteVodFolderItems(slug, q, PAGE_SIZE);
  const { sentinelRef, isFetchingNextPage } = useInfiniteScroll(query);

  if (query.isLoading) return hideWhenEmpty ? null : <SkeletonPosterGrid />;
  if (query.isError) return hideWhenEmpty ? null : (
    <EmptyState title="Catalogue indisponible" hint="Réessayez dans quelques instants." action={<RetryButton onRetry={() => void query.refetch()} />} />
  );
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  if (items.length === 0) {
    if (hideWhenEmpty) return null;
    return <EmptyState title="Aucun résultat" hint={q ? `Aucun titre ne correspond à « ${q} ».` : 'Ce dossier est vide pour le moment.'} />;
  }

  return (
    <>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {items.map((item) => <VodTile key={item.id} item={item} />)}
      </div>
      <div ref={sentinelRef} className="h-10" />
      {isFetchingNextPage && <div className="flex justify-center py-4"><Spinner /></div>}
    </>
  );
}

// hideWhenEmpty : dans les résultats de recherche, une section se retire
// silencieusement si sa source YouTube est vide ou en erreur — les autres
// résultats restent lisibles sans « Aucun résultat » parasite.
export function YoutubeBrowse({ channelId, q, hideWhenEmpty = false }: { channelId: string; q: string; hideWhenEmpty?: boolean }) {
  const query = useInfiniteYoutube(channelId, 25, q);
  const { sentinelRef, isFetchingNextPage } = useInfiniteScroll(query);

  if (query.isLoading) return hideWhenEmpty ? null : <SkeletonVideoGrid />;
  if (query.isError) return hideWhenEmpty ? null : (
    <EmptyState title="Catalogue indisponible" hint="Réessayez dans quelques instants." action={<RetryButton onRetry={() => void query.refetch()} />} />
  );
  // La recherche est déjà SERVEUR (q transmis à l'API) — pas de filtre local.
  // Dédupe par id : un décalage playlistItems duplique un item (key React + visuel).
  const items = dedupeYoutubeItems(query.data?.pages.flatMap((page) => page.items) ?? []);
  if (items.length === 0) {
    if (hideWhenEmpty) return null;
    return <EmptyState title="Aucun résultat" hint={q ? `Aucun titre ne correspond à « ${q} ».` : 'Ce catalogue est vide pour le moment.'} />;
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {items.map((item) => <YoutubeTile key={item.id} item={item} />)}
      </div>
      <div ref={sentinelRef} className="h-10" />
      {isFetchingNextPage && <div className="flex justify-center py-4"><Spinner /></div>}
    </>
  );
}

// Grille fusionnée d'un dossier : toutes les chaînes mélangées, sans nom de
// chaîne, ordre progressif (chaque round trié publishedAt croissant, les
// rounds suivants s'ajoutent en dessous au scroll). Dédupe globale par id.
export function MergedYoutubeBrowse({ channelIds, q, hideWhenEmpty = false }: { channelIds: string[]; q: string; hideWhenEmpty?: boolean }) {
  const query = useInfiniteMergedYoutube(channelIds, 25, q);
  const { sentinelRef, isFetchingNextPage } = useInfiniteScroll(query);

  if (query.isLoading) return hideWhenEmpty ? null : <SkeletonVideoGrid />;
  if (query.isError) return hideWhenEmpty ? null : (
    <EmptyState title="Catalogue indisponible" hint="Réessayez dans quelques instants." action={<RetryButton onRetry={() => void query.refetch()} />} />
  );
  const items = dedupeYoutubeItems(query.data?.pages.flatMap((page) => page.items) ?? []);
  if (items.length === 0) {
    if (hideWhenEmpty) return null;
    return <EmptyState title="Aucun résultat" hint={q ? `Aucun titre ne correspond à « ${q} ».` : 'Ce catalogue est vide pour le moment.'} />;
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {items.map((item) => <YoutubeTile key={item.id} item={item} />)}
      </div>
      <div ref={sentinelRef} className="h-10" />
      {isFetchingNextPage && <div className="flex justify-center py-4"><Spinner /></div>}
    </>
  );
}

// Grille paginée « voir tout » des titres externes (défilement infini),
// filtrée par le type de l'onglet courant et, optionnellement, par genre,
// avec une option de tri (Récents / Nouveautés / Titre A–Z).
export type ExternalSort = 'recent' | 'year' | 'title';

export function ExternalBrowse({ q, kind, genre, sort = 'recent' }: { q: string; kind: 'MOVIE' | 'SERIES'; genre?: string; sort?: ExternalSort }) {
  const query = useInfiniteExternalTitles(q, PAGE_SIZE, kind, genre, sort === 'recent' ? undefined : sort);
  const { sentinelRef, isFetchingNextPage } = useInfiniteScroll(query);

  if (query.isLoading) return <SkeletonPosterGrid />;
  if (query.isError) return (
    <EmptyState title="Catalogue indisponible" hint="Réessayez dans quelques instants." action={<RetryButton onRetry={() => void query.refetch()} />} />
  );
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  if (items.length === 0) return <EmptyState title="Aucun résultat" hint={q ? `Aucun titre ne correspond à « ${q} ».` : 'Ce catalogue est vide pour le moment.'} />;

  return (
    <>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {items.map((item) => <ExternalTile key={item.id} item={item} />)}
      </div>
      <div ref={sentinelRef} className="h-10" />
      {isFetchingNextPage && <div className="flex justify-center py-4"><Spinner /></div>}
    </>
  );
}