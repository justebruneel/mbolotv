'use client';

import { EmptyState, Icon, Spinner } from '@mbolo/ui';
import type { VodFolderSummary, VodKind, YoutubeVideo } from '@mbolo/contracts';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { YOUTUBE_AFOREVO_CHANNEL_ID, useInfiniteVod, useInfiniteVodFolderItems, useInfiniteYoutube, useVodCategories, useVodFolderRows, useVodFolders, useVodHero, useVodRows } from '../../../shared/api/queries';
import { VodTile } from '../../../features/vod/components/VodTile';
import { VodHero } from '../../../features/vod/components/VodHero';
import { VodRow } from '../../../features/vod/components/VodRow';
import { YoutubeTile } from '../../../features/vod/components/YoutubeTile';
import { YoutubeRow } from '../../../features/vod/components/YoutubeRow';
import { useSettingsStore } from '../../../shared/stores/settings';

const PAGE_SIZE = 48;
type Tab = 'MOVIE' | 'SERIES';
// Dossier ouvert = slug géré dans la console (« Catalogue VOD »). La valeur
// 'nollywood' est le slug seedé — les liens historiques ?kind=NOLLYWOOD et
// ?dossier=nollywood y sont canonicalisés.
type Dossier = string | null;

function dossierHref(kind: Tab, slug: string): string {
  return `/vod?${new URLSearchParams({ kind, dossier: slug }).toString()}`;
}
const NOLLYWOOD_DOSSIER_HREF = dossierHref('MOVIE', 'nollywood');

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

// Dédupe par id : un décalage playlistItems (nouvelle vidéo publiée entre
// deux pages) duplique un item — collision de key React + visuel doublé.
function dedupeYoutubeItems(items: YoutubeVideo[]): YoutubeVideo[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

// Rail YouTube d'une source de dossier : première page du catalogue de la
// chaîne (playlistItems = 1 unité de quota, cache sessionStorage 30 min). Se
// masque silencieusement si la source est vide ou en erreur (quota épuisé…) —
// le reste de l'accueil doit rester lisible.
function FolderYoutubeRail({ channelId, title, href }: { channelId: string; title: string; href: string }) {
  const query = useInfiniteYoutube(channelId, 25, '');
  if (query.isLoading || query.isError) return null;
  const items = dedupeYoutubeItems(query.data?.pages[0]?.items ?? []);
  if (items.length === 0) return null;
  return <YoutubeRow title={title} items={items} seeAllHref={href} />;
}

// Repli historique (avant dossiers console / backend injoignable) : le rail
// Nollywood codé en dur, inchangé.
function NollywoodRail() {
  return <FolderYoutubeRail channelId={YOUTUBE_AFOREVO_CHANNEL_ID} title="Nollywood" href={NOLLYWOOD_DOSSIER_HREF} />;
}

// Rails d'un dossier sur l'accueil : rangée VOD (règles ∪ manuel) + une
// rangée par chaîne YouTube active. Rail silencieux si tout est vide/en erreur.
function FolderRail({ folder, tab }: { folder: VodFolderSummary; tab: Tab }) {
  const rowsQuery = useVodFolderRows(folder.slug, 12);
  const data = rowsQuery.data;
  if (rowsQuery.isLoading || rowsQuery.isError || !data) return null;
  const href = dossierHref(tab, folder.slug);
  if (data.items.length === 0 && data.youtubeSources.length === 0) return null;
  return (
    <>
      {data.items.length > 0 && <VodRow title={folder.name} count={data.total} items={data.items} seeAllHref={href} />}
      {data.youtubeSources.map((source) => (
        <FolderYoutubeRail key={source.id} channelId={source.channelId} title={source.label ?? folder.name} href={href} />
      ))}
    </>
  );
}

// Catalogue VOD vide sur l'onglet : les dossiers (et leurs chaînes YouTube)
// portent la page seule au lieu d'un « Aucun résultat » — une panne du
// fournisseur VOD (purge d'import, 0 film actif…) ne doit pas masquer des
// sources YouTube qui, elles, répondent.
function FolderOnly({ folders, tab, onBrowseAll }: { folders: VodFolderSummary[]; tab: Tab; onBrowseAll: () => void }) {
  return (
    <>
      {folders.map((folder) => <FolderRail key={folder.id} folder={folder} tab={tab} />)}
      <div className="mt-2 flex justify-center">
        <button type="button" onClick={onBrowseAll} className="btn">
          Parcourir tout le catalogue <Icon.ChevronRight size={14} />
        </button>
      </div>
    </>
  );
}

// Repli garanti (pas de dossiers en base) : l'ancienne page « Nollywood seul »
// sur l'onglet Films, inchangée.
function NollywoodOnly({ onBrowseAll }: { onBrowseAll: () => void }) {
  const query = useInfiniteYoutube(YOUTUBE_AFOREVO_CHANNEL_ID, 25, '');
  const items = dedupeYoutubeItems(query.data?.pages[0]?.items ?? []);
  // YouTube en cours : on attend — il reste la dernière source vivante.
  if (query.isLoading) return <div className="flex justify-center py-16"><Spinner /></div>;
  // YouTube vide ou en erreur : plus aucune source disponible -> état vide.
  if (items.length === 0) {
    return <EmptyState title="Aucun résultat" hint="Ce catalogue est vide pour le moment." />;
  }
  return (
    <>
      {items.length > 0 && <YoutubeRow title="Nollywood" items={items} seeAllHref={NOLLYWOOD_DOSSIER_HREF} />}
      <div className="mt-2 flex justify-center">
        <button type="button" onClick={onBrowseAll} className="btn">
          Parcourir tout le catalogue <Icon.ChevronRight size={14} />
        </button>
      </div>
    </>
  );
}

// Accueil façon Netflix : héros plein écran (derniers ajouts), rails des
// dossiers gérés dans la console, puis rangées horizontales par catégorie.
// La grille paginée reste disponible en mode filtré (recherche, catégorie,
// « Parcourir tout »).
function VodHome({ kind, onBrowseAll, folders }: { kind: 'MOVIE' | 'SERIES'; onBrowseAll: () => void; folders: VodFolderSummary[] }) {
  const heroQuery = useVodHero(kind);
  const rowsQuery = useVodRows(kind);

  if (heroQuery.isLoading || rowsQuery.isLoading) return <div className="flex justify-center py-16"><Spinner /></div>;
  if (rowsQuery.isError || heroQuery.isError) return <EmptyState title="Catalogue indisponible" hint="Réessayez dans quelques instants." />;

  const hero = heroQuery.data?.items ?? [];
  const rows = rowsQuery.data?.rows ?? [];
  if (rows.length === 0 && hero.length === 0) {
    if (folders.length > 0) return <FolderOnly folders={folders} tab={kind} onBrowseAll={onBrowseAll} />;
    // Sans dossiers en base (repli) : Nollywood seul sur Films, état vide sur Séries.
    return kind === 'MOVIE' ? <NollywoodOnly onBrowseAll={onBrowseAll} /> : <EmptyState title="Aucun résultat" hint="Ce catalogue est vide pour le moment." />;
  }

  return (
    <>
      {hero.length > 0 && <VodHero items={hero} />}
      {folders.length > 0
        ? folders.map((folder) => <FolderRail key={folder.id} folder={folder} tab={kind} />)
        : kind === 'MOVIE' && <NollywoodRail />}
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

// Grille « dans ce dossier » : items règles ∪ manuel, défilement infini.
// hideWhenEmpty : quand le dossier a des chaînes YouTube, une grille vide ou
// en erreur se retire silencieusement — les sections YouTube portent la page.
function FolderVodBrowse({ slug, q, hideWhenEmpty = false }: { slug: string; q: string; hideWhenEmpty?: boolean }) {
  const query = useInfiniteVodFolderItems(slug, q, PAGE_SIZE);
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
      {query.isFetchingNextPage && <div className="flex justify-center py-4"><Spinner /></div>}
    </>
  );
}

// hideWhenEmpty : dans les résultats de recherche, une section se retire
// silencieusement si sa source YouTube est vide ou en erreur — les autres
// résultats restent lisibles sans « Aucun résultat » parasite.
function YoutubeBrowse({ channelId, q, hideWhenEmpty = false }: { channelId: string; q: string; hideWhenEmpty?: boolean }) {
  const query = useInfiniteYoutube(channelId, 25, q);
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

// Vue « dossier » : titre + grille VOD du dossier, puis une grille YouTube
// par chaîne rattachée. `folder` vient de la liste publique ; si le backend
// à dossiers est mort (repli), slug 'nollywood' retrouve exactement l'ancienne
// page mono-Nollywood.
function DossierView({ slug, q, folder }: { slug: string; q: string; folder: VodFolderSummary | null | undefined }) {
  if (folder === undefined) return <div className="flex justify-center py-16"><Spinner /></div>;

  if (folder === null) {
    if (slug !== 'nollywood') {
      return <EmptyState title="Dossier introuvable" hint="Ce dossier n'existe plus ou est masqué." />;
    }
    // Repli intégral (dossiers indisponibles) : l'ancien dossier Nollywood.
    return (
      <section aria-label="Dossier Nollywood">
        <h2 className="mb-4 text-xl font-bold">Nollywood</h2>
        <YoutubeBrowse channelId={YOUTUBE_AFOREVO_CHANNEL_ID} q={q} />
      </section>
    );
  }

  return (
    <section aria-label={`Dossier ${folder.name}`}>
      <h2 className="mb-4 text-xl font-bold">{folder.name}</h2>
      <FolderVodBrowse slug={folder.slug} q={q} hideWhenEmpty={folder.youtubeSources.length > 0} />
      {folder.youtubeSources.map((source, index) => (
        <div key={source.id} className={index === 0 && q ? '' : 'mt-10'}>
          <h3 className="mb-3 text-lg font-bold">{source.label ?? folder.name}</h3>
          <YoutubeBrowse channelId={source.channelId} q={q} hideWhenEmpty={Boolean(q)} />
        </div>
      ))}
    </section>
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
  // Dossier ouvert (collection de l'onglet) : ?dossier=<slug>. Les anciens
  // liens ?kind=NOLLYWOOD sont remappés vers le slug seedé « nollywood ».
  const [dossier, setDossier] = useState<Dossier>(() => {
    const param = searchParams.get('dossier');
    if (param) return param;
    return searchParams.get('kind') === 'NOLLYWOOD' ? 'nollywood' : null;
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
    const next: Dossier = dossierParam ?? null;
    setDossier((prev) => (prev === next ? prev : next));
  }, [dossierParam]);
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
  // Dossiers de la console ; erreur ou liste vide = comportement historique.
  const foldersQuery = useVodFolders(tab);
  const folders = foldersQuery.isError ? [] : foldersQuery.data?.folders ?? [];

  const switchTab = (next: Tab): void => {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set('kind', next);
    url.searchParams.delete('dossier');
    window.history.replaceState(null, '', url.toString());
  };

  const openDossier = (slug: string | null): void => {
    setDossier(slug);
    const url = new URL(window.location.href);
    if (slug) url.searchParams.set('dossier', slug);
    else url.searchParams.delete('dossier');
    window.history.replaceState(null, '', url.toString());
  };

  const dossierFolder = dossier ? folders.find((folder) => folder.slug === dossier) : undefined;
  // Chaînes YouTube actives des dossiers visibles (recherche : une section
  // par chaîne, dédupées — la même chaîne peut alimenter deux dossiers).
  const searchSources = useMemo(() => {
    const seen = new Set<string>();
    const sources: Array<{ id: string; channelId: string; title: string }> = [];
    for (const folder of folders) {
      for (const source of folder.youtubeSources) {
        if (seen.has(source.channelId)) continue;
        seen.add(source.channelId);
        sources.push({ id: source.id, channelId: source.channelId, title: source.label ?? folder.name });
      }
    }
    return sources;
  }, [folders]);

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
        {(category || browseAll || dossier) && (
          <button type="button" onClick={() => { setCategory(null); setBrowseAll(false); openDossier(null); }} className="btn">
            <Icon.ChevronLeft size={14} /> Accueil {tab === 'MOVIE' ? 'films' : 'séries'}
          </button>
        )}
      </div>
      {!q && <ResumeRow />}
      {!dossier && folders.length > 0 && (
        <div className="mb-3 flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {folders.map((folder) => (
            <button key={folder.id} type="button" onClick={() => openDossier(folder.slug)}
              className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-accent/20">
              {folder.name}
            </button>
          ))}
        </div>
      )}
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
        {dossier
          ? <DossierView slug={dossier} q={q} folder={dossierFolder ?? (foldersQuery.isPending ? undefined : null)} />
          : !q && !category && !browseAll
            ? <VodHome kind={tab} onBrowseAll={() => setBrowseAll(true)} folders={folders} />
            : q && (folders.length > 0 || tab === 'MOVIE') ? (
                // Recherche façon Netflix : le catalogue VOD d'abord, puis les
                // collections des dossiers (recherche serveur YouTube).
                <>
                  <VodBrowse kind={tab} category={category} q={q} />
                  {folders.length > 0
                    ? searchSources.map((source) => (
                        <section key={source.id} className="mt-10" aria-label={`Résultats ${source.title}`}>
                          <h2 className="mb-3 text-lg font-bold">{source.title}</h2>
                          <YoutubeBrowse channelId={source.channelId} q={q} hideWhenEmpty />
                        </section>
                      ))
                    : (
                      <section className="mt-10" aria-label="Résultats Nollywood">
                        <h2 className="mb-3 text-lg font-bold">Nollywood</h2>
                        <YoutubeBrowse channelId={YOUTUBE_AFOREVO_CHANNEL_ID} q={q} hideWhenEmpty />
                      </section>
                    )}
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
