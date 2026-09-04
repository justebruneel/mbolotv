'use client';

import { EmptyState, Icon, Spinner } from '@mbolo/ui';
import type { VodKind } from '@mbolo/contracts';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { YOUTUBE_AFOREVO_CHANNEL_ID, useInfiniteVod, useInfiniteYoutube, useVodCategories, useVodHero, useVodRows } from '../../../shared/api/queries';
import { VodTile } from '../../../features/vod/components/VodTile';
import { VodHero } from '../../../features/vod/components/VodHero';
import { VodRow } from '../../../features/vod/components/VodRow';
import { YoutubeTile } from '../../../features/vod/components/YoutubeTile';
import { YoutubeRow } from '../../../features/vod/components/YoutubeRow';
import { useSettingsStore } from '../../../shared/stores/settings';
const PAGE_SIZE = 48;
type Tab = 'MOVIE' | 'SERIES';
type Dossier = 'nollywood' | null;

// Dossier Nollywood : collection YouTube vivant dans l'onglet Films.
const NOLLYWOOD_DOSSIER_HREF = `/vod?${new URLSearchParams({ kind: 'MOVIE', dossier: 'nollywood' }).toString()}`;

function isVodKind(value: string | null): value is Tab {
  return value === 'MOVIE' || value === 'SERIES';
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function ResumeRow() {
  const vodProgress = useSettingsStore((state) => state.vodProgress);
  const entries = useMemo(
    () => Object.values(vodProgress).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 12),
    [vodProgress],
  );
  if (entries.length === 0) return null;
  return (
    <section aria-label="Reprendre la lecture" className="mb-8">
      <h2 className="mb-3 text-lg font-bold">Reprendre</h2>
      <div className="flex gap-3 overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {entries.map((entry) => (
          <a key={entry.id} href={entry.id.startsWith('yt:') ? `/vod/yt/${entry.id.slice(3)}` : `/vod/${entry.id}`} className="group relative w-[136px] shrink-0">
            <div className="relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-surface">
              {entry.posterUrl ? (
                <img src={entry.posterUrl} alt="" loading="lazy" className="h-full w-full object-cover transition group-hover:scale-105" />
              ) : (
                <div className="flex h-full items-center justify-center text-muted"><Icon.Film size={28} /></div>
              )}
              <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50"><div className="h-full bg-accent" style={{ width: `${Math.min(100, (entry.position / Math.max(1, entry.duration)) * 100)}%` }} /></div>
            </div>
            <p className="mt-1.5 truncate text-sm font-semibold">{entry.title}</p>
            <p className="text-xs text-muted">{formatTime(entry.position)} / {formatTime(entry.duration)}</p>
          </a>
        ))}
      </div>
    </section>
  );
}

// Rail Nollywood de l'accueil Films : première page du catalogue YouTube
// (playlistItems = 1 unité de quota, cache sessionStorage 30 min). Se masque
// silencieusement si la source est vide ou en erreur (quota épuisé…) —
// le reste de l'accueil doit rester lisible.
function NollywoodRail() {
  const query = useInfiniteYoutube(YOUTUBE_AFOREVO_CHANNEL_ID, 25, '');
  if (query.isLoading || query.isError) return null;
  // Dédupe par id : un décalage playlistItems (nouvelle vidéo publiée entre
  // deux pages) duplique un item — collision de key React + visuel doublé.
  const items = [...new Map((query.data?.pages[0]?.items ?? []).map((item) => [item.id, item])).values()];
  if (items.length === 0) return null;
  return <YoutubeRow title="Nollywood" items={items} seeAllHref={NOLLYWOOD_DOSSIER_HREF} />;
}

// Accueil façon Netflix : héros plein écran (derniers ajouts), collection
// Nollywood, puis rangées horizontales par catégorie. La grille paginée
// reste disponible en mode filtré (recherche, catégorie, « Parcourir tout »).
function VodHome({ kind, onBrowseAll }: { kind: 'MOVIE' | 'SERIES'; onBrowseAll: () => void }) {
  const heroQuery = useVodHero(kind);
  const rowsQuery = useVodRows(kind);

  if (heroQuery.isLoading || rowsQuery.isLoading) return <div className="flex justify-center py-16"><Spinner /></div>;
  if (rowsQuery.isError || heroQuery.isError) return <EmptyState title="Catalogue indisponible" hint="Réessayez dans quelques instants." />;

  const hero = heroQuery.data?.items ?? [];
  const rows = rowsQuery.data?.rows ?? [];
  if (rows.length === 0 && hero.length === 0) return <EmptyState title="Aucun résultat" hint="Ce catalogue est vide pour le moment." />;

  return (
    <>
      {hero.length > 0 && <VodHero items={hero} />}
      {kind === 'MOVIE' && <NollywoodRail />}
      {rows.map((row) => (
        <VodRow key={row.name} title={row.name} count={row.count} items={row.items} seeAllKind={kind} seeAllCategory={row.name === 'Nouveautés' ? '' : row.name} />
      ))}
      <div className="mt-2 flex justify-center">
        <button type="button" onClick={onBrowseAll} className="btn">
          Parcourir tout le catalogue <Icon.ChevronRight size={14} />
        </button>
      </div>
    </>
  );
}

function VodBrowse({ kind, category, q }: { kind: VodKind; category: string | null; q: string }) {
  const query = useInfiniteVod({ kind, category: category ?? undefined, q: q || undefined }, PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && query.hasNextPage && !query.isFetchingNextPage && !loadingMore) {
        setLoadingMore(true);
        void query.fetchNextPage().finally(() => setLoadingMore(false));
      }
    }, { rootMargin: '600px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage, loadingMore]);

  if (query.isLoading) return <div className="flex justify-center py-16"><Spinner /></div>;
  if (query.isError) return <EmptyState title="Catalogue indisponible" hint="Réessayez dans quelques instants." />;
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  if (items.length === 0) return <EmptyState title="Aucun résultat" hint={q ? `Aucun titre ne correspond à « ${q} ».` : 'Ce catalogue est vide pour le moment.'} />;

  return (
    <>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {items.map((item) => <VodTile key={item.id} item={item} />)}
      </div>
      <div ref={sentinelRef} className="h-10" />
      {query.isFetchingNextPage && <div className="flex justify-center py-4"><Spinner /></div>}
    </>
  );
}

// hideWhenEmpty : dans les résultats de recherche, la section Nollywood se
// retire silencieusement si la source YouTube est vide ou en erreur — les
// résultats VOD restent alors lisibles sans « Aucun résultat » parasite.
function YoutubeBrowse({ q, hideWhenEmpty = false }: { q: string; hideWhenEmpty?: boolean }) {
  const query = useInfiniteYoutube(YOUTUBE_AFOREVO_CHANNEL_ID, 25, q);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && query.hasNextPage && !query.isFetchingNextPage && !loadingMore) {
        setLoadingMore(true);
        void query.fetchNextPage().finally(() => setLoadingMore(false));
      }
    }, { rootMargin: '600px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage, loadingMore]);

  if (query.isLoading) return hideWhenEmpty ? null : <div className="flex justify-center py-16"><Spinner /></div>;
  if (query.isError) return hideWhenEmpty ? null : <EmptyState title="Catalogue indisponible" hint="Réessayez dans quelques instants." />;
  // Pas de filtre local en surplus : la recherche est déjà SERVEUR (q transmis
  // à l'API, 100 unités de quota). Un includes() local sur le titre excluait
  // des résultats pertinents (match description) -> faux « Aucun résultat »
  // pour des résultats pourtant payés.
  // Dédupe par id : un décalage playlistItems (nouvelle vidéo publiée entre
  // deux pages) duplique un item — collision de key React + visuel doublé.
  const items = [...new Map((query.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.id, item])).values()];
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
      {query.isFetchingNextPage && <div className="flex justify-center py-4"><Spinner /></div>}
    </>
  );
}

function VodPageContent() {
  const searchParams = useSearchParams();
  const q = searchParams.get('q') ?? '';
  // Onglet actif : ?kind= (Films par défaut). L'URL fait foi pour les liens
  // directs et le retour navigateur — pas d'état persisté superflu.
  const [tab, setTab] = useState<Tab>(() => {
    const value = searchParams.get('kind');
    return value === 'NOLLYWOOD' ? 'MOVIE' : isVodKind(value) ? value : 'MOVIE';
  });
  // Dossier Nollywood (collection de l'onglet Films) : ?dossier=nollywood.
  // Les anciens liens ?kind=NOLLYWOOD sont remappés vers cette forme.
  const [dossier, setDossier] = useState<Dossier>(() => {
    return searchParams.get('dossier') === 'nollywood' || searchParams.get('kind') === 'NOLLYWOOD' ? 'nollywood' : null;
  });
  const [category, setCategory] = useState<string | null>(null);
  const [browseAll, setBrowseAll] = useState(false);

  const kindParam = searchParams.get('kind');
  const dossierParam = searchParams.get('dossier');
  // Synchronisation depuis l'URL (navigation, replaceState du routeur).
  // Déclaré AVANT l'effet legacy : sur un lien ?kind=NOLLYWOOD, dossierParam
  // vaut null au montage et cet effet remettrait le dossier à null — le
  // remap legacy (ci-dessous) doit passer en dernier pour gagner.
  useEffect(() => {
    const next: Dossier = dossierParam === 'nollywood' && tab === 'MOVIE' ? 'nollywood' : null;
    setDossier((prev) => (prev === next ? prev : next));
  }, [dossierParam, tab]);
  useEffect(() => {
    if (kindParam === 'NOLLYWOOD') {
      // Ancien onglet devenu dossier : canonicalise l'URL pour les liens
      // déjà partagés.
      setTab('MOVIE');
      setDossier('nollywood');
      const url = new URL(window.location.href);
      url.searchParams.set('kind', 'MOVIE');
      url.searchParams.set('dossier', 'nollywood');
      window.history.replaceState(null, '', url.toString());
      return;
    }
    if (isVodKind(kindParam)) setTab(kindParam);
  }, [kindParam]);
  useEffect(() => { setCategory(null); setBrowseAll(false); }, [tab]);

  const categories = useVodCategories(tab);

  const switchTab = (next: Tab): void => {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set('kind', next);
    url.searchParams.delete('dossier');
    window.history.replaceState(null, '', url.toString());
  };

  const toggleDossier = (open: boolean): void => {
    setDossier(open ? 'nollywood' : null);
    const url = new URL(window.location.href);
    if (open) url.searchParams.set('dossier', 'nollywood');
    else url.searchParams.delete('dossier');
    window.history.replaceState(null, '', url.toString());
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2" role="tablist" aria-label="Type de contenu">
          {(['MOVIE', 'SERIES'] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => switchTab(value)}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${tab === value ? 'bg-accent text-white' : 'bg-surface text-muted hover:text-text'}`}>
              {value === 'MOVIE' ? 'Films' : 'Séries'}
            </button>
          ))}
        </div>
        {(category || browseAll || dossier === 'nollywood') && (
          <button type="button" onClick={() => { setCategory(null); setBrowseAll(false); toggleDossier(false); }} className="btn">
            <Icon.ChevronLeft size={14} /> Accueil {tab === 'MOVIE' ? 'films' : 'séries'}
          </button>
        )}
      </div>
      {!q && <ResumeRow />}
      {!dossier && categories.data && categories.data.length > 1 && (
        <div className="mb-5 flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button type="button" onClick={() => setCategory(null)}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${category === null ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:text-text'}`}>
            Tout
          </button>
          {categories.data.map((entry) => (
            <button key={entry.name} type="button" onClick={() => { setCategory(category === entry.name ? null : entry.name); setBrowseAll(false); }}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${category === entry.name ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:text-text'}`}>
              {entry.name} <span className="opacity-60">{entry.count}</span>
            </button>
          ))}
        </div>
      )}
      <Suspense fallback={<div className="flex justify-center py-16"><Spinner /></div>}>
        {dossier === 'nollywood'
          ? (
            <section aria-label="Dossier Nollywood">
              <h2 className="mb-4 text-xl font-bold">Nollywood</h2>
              <YoutubeBrowse q={q} />
            </section>
          )
          : !q && !category && !browseAll
            ? <VodHome kind={tab} onBrowseAll={() => setBrowseAll(true)} />
            : tab === 'MOVIE' && q ? (
                // Recherche façon Netflix : le catalogue VOD d'abord, la
                // collection Nollywood dessous (recherche serveur YouTube).
                <>
                  <VodBrowse kind={tab} category={category} q={q} />
                  <section className="mt-10" aria-label="Résultats Nollywood">
                    <h2 className="mb-3 text-lg font-bold">Nollywood</h2>
                    <YoutubeBrowse q={q} hideWhenEmpty />
                  </section>
                </>
              )
              : <VodBrowse kind={tab} category={category} q={q} />}
      </Suspense>
    </div>
  );
}

export default function VodPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-16"><Spinner /></div>}>
      <VodPageContent />
    </Suspense>
  );
}
