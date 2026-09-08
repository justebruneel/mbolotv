'use client';

import { EmptyState, Icon, Spinner } from '@mbolo/ui';
import type { VodFolderSummary, VodKind, YoutubeVideo } from '@mbolo/contracts';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { YOUTUBE_AFOREVO_CHANNEL_ID, useExternalGenres, useInfiniteExternalTitles, useInfiniteMergedYoutube, useInfiniteVod, useInfiniteVodFolderItems, useInfiniteYoutube, useVodCategories, useVodFolderRows, useVodFolders, useVodHero, useVodRows } from '../../../shared/api/queries';
import { VodTile } from '../../../features/vod/components/VodTile';
import { VodHero } from '../../../features/vod/components/VodHero';
import { VodRow } from '../../../features/vod/components/VodRow';
import { ExternalRow } from '../../../features/vod/components/ExternalRow';
import { ExternalTile } from '../../../features/vod/components/ExternalTile';
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

// Lien d'une tuile « Reprendre » : les entrées sont préfixées par leur espace
// (yt: Nollywood, x: titres externes) pour ne pas collisionner avec les ids
// VodItem Xtream ; sans préfixe => fiche VOD Xtream classique.
function resumeHref(id: string): string {
  if (id.startsWith('yt:')) return `/vod/yt/${id.slice(3)}`;
  if (id.startsWith('x:')) return `/vod/x/${id.slice(2)}`;
  return `/vod/${id}`;
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
          <a key={entry.id} href={resumeHref(entry.id)} className="group relative w-[136px] shrink-0">
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

// Aperçu d'un dossier sur l'accueil : UN seul rail fusionné (toutes les
// chaînes YouTube du dossier mélangées, tri publishedAt croissant par round,
// affichage progressif). Titre = nom du dossier, sans nom de chaîne.
// Dossiers extensibles : chaque dossier console donne un rail générique.
function FolderMergedRail({ folder, href, previewCount = 25 }: { folder: VodFolderSummary; href: string; previewCount?: number }) {
  const channelIds = useMemo(() => folder.youtubeSources.map((source) => source.channelId), [folder]);
  const query = useInfiniteMergedYoutube(channelIds, 25, '');
  if (query.isLoading || query.isError) return null;
  const items = dedupeYoutubeItems(query.data?.pages[0]?.items ?? []).slice(0, previewCount);
  if (items.length === 0) return null;
  return <YoutubeRow title={folder.name} items={items} seeAllHref={href} />;
}

// Rails d'un dossier sur l'accueil : un seul rail fusionné si le dossier a des
// chaînes YouTube, sinon repli rangée VOD (règles ∪ manuel). Rail silencieux
// si tout est vide/en erreur.
function FolderRail({ folder, tab }: { folder: VodFolderSummary; tab: Tab }) {
  const href = dossierHref(tab, folder.slug);
  const hasYoutube = folder.youtubeSources.length > 0;
  // Hook appelé sans condition (slug null = requête désactivée) pour garder
  // un ordre de hooks stable — le rail fusionné n'en a pas besoin.
  const rowsQuery = useVodFolderRows(hasYoutube ? null : folder.slug, 12);
  if (hasYoutube) {
    return <FolderMergedRail folder={folder} href={href} />;
  }
  const data = rowsQuery.data;
  if (rowsQuery.isLoading || rowsQuery.isError || !data) return null;
  if (data.items.length === 0) return null;
  return <VodRow title={folder.name} count={data.total} items={data.items} seeAllHref={href} />;
}

// Catalogue VOD vide sur l'onglet : les dossiers (et leurs chaînes YouTube)
// portent la page seule au lieu d'un « Aucun résultat » — une panne du
// fournisseur VOD (purge d'import, 0 film actif…) ne doit pas masquer des
// sources YouTube qui, elles, répondent.
// « Parcourir tout » retiré de l'accueil (Netflix n'a pas de bouton « tout
// voir » en bas de page : on navigue par rangées et catégories) — les props
// onBrowseAll restent pour la signature des deux replis mais sont muettes.
function FolderOnly({ folders, tab }: { folders: VodFolderSummary[]; tab: Tab }) {
  return (
    <>
      {folders.map((folder) => <FolderRail key={folder.id} folder={folder} tab={tab} />)}
    </>
  );
}

// Repli garanti (pas de dossiers en base) : l'ancienne page « Nollywood seul »
// sur l'onglet Films.
// suppressEmpty : quand une autre source (titres externes) porte déjà la page,
// on se tait au lieu d'afficher un « Aucun résultat » mensonger.
function NollywoodOnly({ suppressEmpty = false }: { suppressEmpty?: boolean }) {
  const query = useInfiniteYoutube(YOUTUBE_AFOREVO_CHANNEL_ID, 25, '');
  const items = dedupeYoutubeItems(query.data?.pages[0]?.items ?? []);
  // YouTube en cours : on attend — il reste la dernière source vivante.
  if (query.isLoading) return <div className="flex justify-center py-16"><Spinner /></div>;
  // YouTube vide ou en erreur : plus aucune source disponible -> état vide,
  // sauf si une autre source porte la page (suppressEmpty).
  if (items.length === 0) {
    if (suppressEmpty) return null;
    return <EmptyState title="Aucun résultat" hint="Ce catalogue est vide pour le moment." />;
  }
  return (
    <>
      {items.length > 0 && <YoutubeRow title="Nollywood" items={items} seeAllHref={NOLLYWOOD_DOSSIER_HREF} />}
    </>
  );
}

// Accueil quand le catalogue Xtream (hero + rows) est vide : les autres
// sources (dossiers YouTube, titres externes) portent la page. Le « Aucun
// résultat » Xtream ne doit jamais s'afficher AU-DESSUS d'un rail qui a du
// contenu — sinon message en haut + séries en bas. L'état vide global n'est
// montré que quand tout est définitivement vide.
function VodHomeEmpty({ kind, onBrowseExternal, onBrowseGenre, folders }: { kind: 'MOVIE' | 'SERIES'; onBrowseExternal: () => void; onBrowseGenre: (genre: string) => void; folders: VodFolderSummary[] }) {
  const externalPreview = useInfiniteExternalTitles('', 12, kind, undefined, 'year');
  const externalItems = (externalPreview.data?.pages[0]?.items ?? []).slice(0, 12);
  const hasExternal = externalItems.length > 0;
  const isExternalLoading = externalPreview.isLoading;
  const genresQuery = useExternalGenres(kind);
  const hasGenres = (genresQuery.data?.genres ?? []).length > 0;
  const isGenresLoading = genresQuery.isLoading;
  const externalTitle = kind === 'SERIES' ? 'Séries — Nouveau sur Mbolo' : 'Nouveau sur Mbolo';

  // Dossiers console : ils portent la page seuls, pas de « vide » Xtream.
  // Les rails vides/en erreur se taisent (FolderRail -> null) comme avant.
  if (folders.length > 0) {
    return (
      <>
        <FolderOnly folders={folders} tab={kind} />
        {hasExternal && <ExternalRow title={externalTitle} items={externalItems} onSeeAll={onBrowseExternal} />}
        <ExternalGenreRails kind={kind} onBrowseGenre={onBrowseGenre} />
      </>
    );
  }

  // Onglet Films sans dossiers : Nollywood + externes se partagent la page.
  // Le vide Nollywood est supprimé dès que les externes/genres chargent ou
  // ont du contenu, pour éviter le flash « vide » puis l'apparition du rail.
  if (kind === 'MOVIE') {
    const suppressNollywoodEmpty = isExternalLoading || isGenresLoading || hasExternal || hasGenres;
    return (
      <>
        <NollywoodOnly suppressEmpty={suppressNollywoodEmpty} />
        {hasExternal
          ? <ExternalRow title={externalTitle} items={externalItems} onSeeAll={onBrowseExternal} />
          : isExternalLoading
            ? <div className="flex justify-center py-16"><Spinner /></div>
            : null}
        <ExternalGenreRails kind={kind} onBrowseGenre={onBrowseGenre} />
      </>
    );
  }

  // Onglet Séries sans dossiers : seuls les externes peuvent porter la page.
  if (isExternalLoading || isGenresLoading) return <div className="flex justify-center py-16"><Spinner /></div>;
  if (hasExternal || hasGenres) {
    return (
      <>
        {hasExternal && <ExternalRow title={externalTitle} items={externalItems} onSeeAll={onBrowseExternal} />}
        <ExternalGenreRails kind={kind} onBrowseGenre={onBrowseGenre} />
      </>
    );
  }
  return <EmptyState title="Aucun résultat" hint="Ce catalogue est vide pour le moment." />;
}

// Accueil façon Netflix : héros plein écran (derniers ajouts), rails des
// dossiers gérés dans la console, puis rangées horizontales éditoriales.
// PAS de bouton « Parcourir tout » : on navigue par rangées et par la
// barre de catégories (browseAll reste pour les modes filtrés).
function VodHome({ kind, onBrowseExternal, onBrowseGenre, folders }: { kind: 'MOVIE' | 'SERIES'; onBrowseExternal: () => void; onBrowseGenre: (genre: string) => void; folders: VodFolderSummary[] }) {
  const heroQuery = useVodHero(kind);
  const rowsQuery = useVodRows(kind);

  if (heroQuery.isLoading || rowsQuery.isLoading) return <div className="flex justify-center py-16"><Spinner /></div>;
  if (rowsQuery.isError || heroQuery.isError) return <EmptyState title="Catalogue indisponible" hint="Réessayez dans quelques instants." />;

  const hero = heroQuery.data?.items ?? [];
  const rows = rowsQuery.data?.rows ?? [];
  if (rows.length === 0 && hero.length === 0) {
    // Catalogue Xtream vide : délégué à VodHomeEmpty qui ne montre le vide
    // que si dossiers + externes sont aussi définitivement vides.
    return <VodHomeEmpty kind={kind} onBrowseExternal={onBrowseExternal} onBrowseGenre={onBrowseGenre} folders={folders} />;
  }

  return (
    <>
      {hero.length > 0 && <VodHero items={hero} />}
      {folders.length > 0
        ? folders.map((folder) => <FolderRail key={folder.id} folder={folder} tab={kind} />)
        : kind === 'MOVIE' && <NollywoodRail />}
      {rows.map((row) => (
        <VodRow key={`${row.category ?? row.name}`} title={row.name} count={row.count} items={row.items} seeAllKind={kind} seeAllCategory={row.category ?? (row.name === 'Nouveautés' ? '' : row.name)} />
      ))}
      {/* Rail « Nouveau sur Mbolo » APRÈS les rangées : il fait écho au hero
          (les dernières sorties), pas une entrée de catalogue à part. Puis un
          rail par genre présent dans l'onglet (comme les dossiers). Masqués en
          mode filtré par la page (browseExternal/browseGenre gèrent les
          grilles complètes). */}
      {<ExternalRail onBrowseAll={onBrowseExternal} kind={kind} />}
      {<ExternalGenreRails kind={kind} onBrowseGenre={onBrowseGenre} />}
    </>
  );
}

// Signale au parent (recherche unifiée) qu'une section a répondu, vide ou
// non. Idempotent : marquer la même valeur ne re-render pas (le parent garde
// prev si rien ne change).
function useSectionSettled(onSettled: ((empty: boolean) => void) | undefined, settled: boolean, empty: boolean): void {
  useEffect(() => {
    if (settled) onSettled?.(empty);
  }, [onSettled, settled, empty]);
}

function VodBrowse({ kind, category, q, hideWhenEmpty = false, onSettled }: { kind: VodKind; category: string | null; q: string; hideWhenEmpty?: boolean; onSettled?: (empty: boolean) => void }) {
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

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  useSectionSettled(onSettled, !query.isLoading && !query.isPlaceholderData, query.isError || items.length === 0);

  if (query.isLoading) return <div className="flex justify-center py-16"><Spinner /></div>;
  if (query.isError) return hideWhenEmpty ? null : <EmptyState title="Catalogue indisponible" hint="Réessayez dans quelques instants." />;
  // hideWhenEmpty (mode recherche) : le catalogue Xtream est aujourd'hui
  // vide (0 import) — sa grille muette laisse la place aux sections qui ont
  // du contenu ; l'état vide global est rendu par le parent.
  if (items.length === 0) return hideWhenEmpty ? null : <EmptyState title="Aucun résultat" hint={q ? `Aucun titre ne correspond à « ${q} ».` : 'Ce catalogue est vide pour le moment.'} />;

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
function YoutubeBrowse({ channelId, q, hideWhenEmpty = false }: { channelId: string; q: string; hideWhenEmpty?: boolean }) {  const query = useInfiniteYoutube(channelId, 25, q);
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

// Grille fusionnée d'un dossier : toutes les chaînes mélangées, sans nom de
// chaîne, ordre progressif (chaque round trié publishedAt croissant, les
// rounds suivants s'ajoutent en dessous au scroll — pas de tri global qui
// ferait sauter la grille à chaque page). Dédupe globale par id.
function MergedYoutubeBrowse({ channelIds, q, hideWhenEmpty = false }: { channelIds: string[]; q: string; hideWhenEmpty?: boolean }) {
  const query = useInfiniteMergedYoutube(channelIds, 25, q);
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
      {query.isFetchingNextPage && <div className="flex justify-center py-4"><Spinner /></div>}
    </>
  );
}

// Rail d'accueil des titres externes (lecteurs tiers) : aperçu silencieux.
// « Nouveau sur Mbolo » (films) / « Séries — Nouveau sur Mbolo » selon
// l'onglet — trié par date de sortie (année DESC) : les sorties récentes,
// pas les derniers imports. « Voir tout » bascule la grille paginée (état
// local browseExternal, comme browseAll).
function ExternalRail({ previewCount = 12, onBrowseAll, kind }: { previewCount?: number; onBrowseAll: () => void; kind: 'MOVIE' | 'SERIES' }) {
  const query = useInfiniteExternalTitles('', previewCount, kind, undefined, 'year');
  if (query.isLoading || query.isError) return null;
  const items = (query.data?.pages[0]?.items ?? []).slice(0, previewCount);
  if (items.length === 0) return null;
  return <ExternalRow title={kind === 'SERIES' ? 'Séries — Nouveau sur Mbolo' : 'Nouveau sur Mbolo'} items={items} onSeeAll={onBrowseAll} />;
}

// Rail d'un genre (titres externes) : même coquille que les rails de dossiers
// (titre + « Voir tout »), silencieux si vide/en erreur.
function ExternalGenreRail({ kind, genre, onSeeAll }: { kind: 'MOVIE' | 'SERIES'; genre: string; onSeeAll: () => void }) {
  const query = useInfiniteExternalTitles('', 12, kind, genre);
  if (query.isLoading || query.isError) return null;
  const items = (query.data?.pages[0]?.items ?? []).slice(0, 12);
  if (items.length === 0) return null;
  return <ExternalRow title={genre} items={items} onSeeAll={onSeeAll} />;
}

// Rails de tous les genres présents dans l'onglet (dynamique via /x/genres,
// par kind) — comme les rails de dossiers, un par genre avec son Voir tout.
function ExternalGenreRails({ kind, onBrowseGenre }: { kind: 'MOVIE' | 'SERIES'; onBrowseGenre: (genre: string) => void }) {
  const query = useExternalGenres(kind);
  if (query.isLoading || query.isError) return null;
  const genres = query.data?.genres ?? [];
  if (genres.length === 0) return null;
  return (
    <>
      {genres.map((entry) => (
        <ExternalGenreRail key={entry.name} kind={kind} genre={entry.name} onSeeAll={() => onBrowseGenre(entry.name)} />
      ))}
    </>
  );
}

// Grille paginée « voir tout » des titres externes (défilement infini),
// filtrée par le type de l'onglet courant et, optionnellement, par genre.
function ExternalBrowse({ q, kind, genre }: { q: string; kind: 'MOVIE' | 'SERIES'; genre?: string }) {
  const query = useInfiniteExternalTitles(q, PAGE_SIZE, kind, genre);
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
        {items.map((item) => <ExternalTile key={item.id} item={item} />)}
      </div>
      <div ref={sentinelRef} className="h-10" />
      {query.isFetchingNextPage && <div className="flex justify-center py-4"><Spinner /></div>}
    </>
  );
}

// Section recherche des titres externes (première page, silencieuse si vide),
// filtrée par le type de l'onglet courant.
function ExternalSearch({ q, kind, onSettled }: { q: string; kind: 'MOVIE' | 'SERIES'; onSettled?: (empty: boolean) => void }) {
  const query = useInfiniteExternalTitles(q, 12, kind);
  const items = query.data?.pages[0]?.items ?? [];
  useSectionSettled(onSettled, !query.isLoading && !query.isPlaceholderData, query.isError || items.length === 0);
  if (query.isLoading || query.isError) return null;
  if (items.length === 0) return null;
  return (
    <section className="mt-10" aria-label="Résultats titres externes">
      <h2 className="mb-3 text-lg font-bold">{kind === 'SERIES' ? 'Séries' : 'Films'}</h2>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {items.map((item) => <ExternalTile key={item.id} item={item} />)}
      </div>
    </section>
  );
}

// Section YouTube d'un dossier en mode recherche : le titre de section ne
// s'affiche QUE si la recherche a des résultats (en-tête « Afrique » vide
// au-dessus de « aucun résultat » = exactly the misleading render we're fixing).
function FolderSearchSection({ section, q, onSettled }: { section: { id: string; name: string; channelIds: string[] }; q: string; onSettled?: (empty: boolean) => void }) {
  const query = useInfiniteMergedYoutube(section.channelIds, 25, q);
  const items = dedupeYoutubeItems(query.data?.pages.flatMap((page) => page.items) ?? []);
  useSectionSettled(onSettled, !query.isLoading && !query.isPlaceholderData, query.isError || items.length === 0);
  if (items.length === 0) return null;
  return (
    <section className="mt-10" aria-label={`Résultats ${section.name}`}>
      <h2 className="mb-3 text-lg font-bold">{section.name}</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {items.map((item) => <YoutubeTile key={item.id} item={item} />)}
      </div>
    </section>
  );
}

// Section Nollywood (repli hors dossier) en mode recherche — muette si vide.
function NollywoodSearchSection({ q, onSettled }: { q: string; onSettled?: (empty: boolean) => void }) {
  const query = useInfiniteYoutube(YOUTUBE_AFOREVO_CHANNEL_ID, 25, q);
  const items = dedupeYoutubeItems(query.data?.pages.flatMap((page) => page.items) ?? []);
  useSectionSettled(onSettled, !query.isLoading && !query.isPlaceholderData, query.isError || items.length === 0);
  if (items.length === 0) return null;
  return (
    <section className="mt-10" aria-label="Résultats Nollywood">
      <h2 className="mb-3 text-lg font-bold">Nollywood</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {items.map((item) => <YoutubeTile key={item.id} item={item} />)}
      </div>
    </section>
  );
}

// Recherche unifiée Films & Séries : quatre sources potentielles (catalogue
// Xtream, titres externes, un rail YouTube par dossier — ou Nollywood en
// repli). Chacune est MUETTE quand elle ne trouve rien, y compris son
// en-tête : l'ancien rendu affichait « Aucun résultat » du catalogue Xtream
// (vide aujourd'hui — les titres importés sont externes) EN TÊTE de page,
// par-dessus les vrais résultats plus bas — d'où l'impression que la
// recherche ne marche jamais. L'état vide n'est plus que GLOBAL : affiché
// uniquement quand TOUTES les sources attendues ont répondu vides.
function VodSearch({ kind, category, q, folders, searchFolders }: {
  kind: Tab;
  category: string | null;
  q: string;
  folders: VodFolderSummary[];
  searchFolders: Array<{ id: string; name: string; channelIds: string[] }>;
}) {
  // État « vide/non-vide » par source attendue. Réinitialisé à chaque mot
  // (sinon un « Aucun résultat » resterait affiché pendant la frappe
  // suivante, le temps que les sources re-répondent).
  const [empties, setEmpties] = useState<Record<string, boolean>>({});
  useEffect(() => { setEmpties({}); }, [q, kind]);
  const markEmpty = useCallback((key: string, empty: boolean) => {
    setEmpties((previous) => (previous[key] === empty ? previous : { ...previous, [key]: empty }));
  }, []);

  const showYoutubeSections = folders.length > 0 || kind === 'MOVIE';
  const youtubeKeys = showYoutubeSections
    ? (searchFolders.length > 0 ? searchFolders.map((section) => `yt:${section.id}`) : ['yt:nollywood'])
    : [];
  const expectedKeys = ['vod', 'external', ...youtubeKeys];
  const allEmpty = expectedKeys.every((key) => empties[key] === true);

  return (
    <>
      <VodBrowse kind={kind} category={category} q={q} hideWhenEmpty onSettled={(empty) => markEmpty('vod', empty)} />
      <ExternalSearch q={q} kind={kind} onSettled={(empty) => markEmpty('external', empty)} />
      {showYoutubeSections && (searchFolders.length > 0
        ? searchFolders.map((section) => (
            <FolderSearchSection key={section.id} section={section} q={q} onSettled={(empty) => markEmpty(`yt:${section.id}`, empty)} />
          ))
        : <NollywoodSearchSection q={q} onSettled={(empty) => markEmpty('yt:nollywood', empty)} />)}
      {allEmpty && <EmptyState title="Aucun résultat" hint={`Aucun titre ne correspond à « ${q} ».`} />}
    </>
  );
}

// Vue « dossier » (= la page « voir tout » du rail) : l'en-tête de page fait
// déjà office de titre (barre dossiers/catégories + bouton retour) — le
// <h2> interne doublait chaque nom (« Afrique » au-dessus de « Afrique »)
// et est supprimé. La grille occupe l'espace, c'est tout.
function DossierView({ slug, q, folder }: { slug: string; q: string; folder: VodFolderSummary | null | undefined }) {
  if (folder === undefined) return <div className="flex justify-center py-16"><Spinner /></div>;

  if (folder === null) {
    if (slug !== 'nollywood') {
      return <EmptyState title="Dossier introuvable" hint="Ce dossier n'existe plus ou est masqué." />;
    }
    // Repli intégral (dossiers indisponibles) : l'ancien dossier Nollywood.
    return <YoutubeBrowse channelId={YOUTUBE_AFOREVO_CHANNEL_ID} q={q} />;
  }

  const channelIds = folder.youtubeSources.map((source) => source.channelId);
  if (channelIds.length === 0) {
    return <FolderVodBrowse slug={folder.slug} q={q} />;
  }

  return <MergedYoutubeBrowse channelIds={channelIds} q={q} />;
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
  // Filtres portés par l'URL (?cat=, ?ext=1, ?genre=) : le retour navigateur
  // (remontée depuis une fiche) restaure la vue exacte laissée — même motif
  // que tab/dossier ci-dessus. Les setters écrivent le state (rendu
  // immédiat) ET l'URL (historique).
  const [category, setCategoryState] = useState<string | null>(() => searchParams.get('cat'));
  const [browseExternal, setBrowseExternalState] = useState<boolean>(() => searchParams.get('ext') === '1');
  const [browseGenre, setBrowseGenreState] = useState<string | null>(() => searchParams.get('genre'));
  const writeVodParams = (mutate: (params: URLSearchParams) => void): void => {
    const url = new URL(window.location.href);
    mutate(url.searchParams);
    window.history.replaceState(null, '', url.toString());
  };
  const setCategory = (value: string | null): void => {
    setCategoryState(value);
    writeVodParams((params) => (value ? params.set('cat', value) : params.delete('cat')));
  };
  const setBrowseExternal = (value: boolean): void => {
    setBrowseExternalState(value);
    writeVodParams((params) => (value ? params.set('ext', '1') : params.delete('ext')));
  };
  const setBrowseGenre = (value: string | null): void => {
    setBrowseGenreState(value);
    writeVodParams((params) => (value ? params.set('genre', value) : params.delete('genre')));
  };

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
  const prevTabRef = useRef(tab);
  useEffect(() => {
    if (prevTabRef.current === tab) return;
    prevTabRef.current = tab;
    setCategory(null);
    setBrowseExternal(false);
    setBrowseGenre(null);
  }, [tab]);

  const categories = useVodCategories(tab);
  // Dossiers de la console ; erreur ou liste vide = comportement historique.
  const foldersQuery = useVodFolders(tab);
  const folders = foldersQuery.isError ? [] : foldersQuery.data?.folders ?? [];

  const switchTab = (next: Tab): void => {
    setTab(next);
    setBrowseExternal(false);
    setBrowseGenre(null);
    setCategory(null);
    const url = new URL(window.location.href);
    url.searchParams.set('kind', next);
    url.searchParams.delete('dossier');
    url.searchParams.delete('cat');
    url.searchParams.delete('ext');
    url.searchParams.delete('genre');
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
  // Recherche fusionnée : UNE section par dossier (toutes ses chaînes
  // mélangées, sans nom de chaîne). Dossiers extensibles : chaque nouveau
  // dossier console apparaît comme une section générique.
  const searchFolders = useMemo(
    () =>
      folders
        .filter((folder) => folder.youtubeSources.length > 0)
        .map((folder) => ({
          id: folder.id,
          name: folder.name,
          channelIds: folder.youtubeSources.map((source) => source.channelId),
        })),
    [folders],
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      {/* Onglets Films / Séries façon Netflix : navigation ancrée en haut de
          page, texte seul, l'onglet actif en gras blanc, l'inactif atténué —
          pas de pills (Netflix n'en a pas), la hiérarchie passe par le poids. */}
      <div className="mb-5 flex items-center justify-between gap-3">
        <nav className="flex items-center gap-5" role="tablist" aria-label="Type de contenu">
          {(['MOVIE', 'SERIES'] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => switchTab(value)}
              className={`relative pb-1 text-lg font-bold transition md:text-xl ${tab === value ? 'text-foreground' : 'text-muted hover:text-foreground/70'}`}>
              {value === 'MOVIE' ? 'Films' : 'Séries'}
              {/* Soulignement accent sous l'onglet actif (marqueur Netflix). */}
              {tab === value && <span className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-accent" aria-hidden />}
            </button>
          ))}
        </nav>
        {(category || browseExternal || browseGenre || dossier) && (
          <button type="button" onClick={() => { setCategory(null); setBrowseExternal(false); setBrowseGenre(null); openDossier(null); }} className="btn">
            <Icon.ChevronLeft size={14} /> Accueil {tab === 'MOVIE' ? 'films' : 'séries'}
          </button>
        )}
      </div>
      {/* Reprendre : accueil uniquement — dans les vues filtrées (« voir
          tout », dossier, catégorie, recherche) la grille EST le contenu,
          une rangée de reprise décalerait tout vers le bas sans servir. */}
      {!q && !dossier && !category && !browseExternal && !browseGenre && <ResumeRow />}
      {/* Dossiers façon Netflix : texte seul dans la même barre que les
          catégories — l'actif blanc + soulignement accent, l'inactif
          atténué. Séparés des catégories par un « | » discret (rôles
          différents : collections vs filtres). */}
      {/* Barre dossiers + catégories : ACCUEIL de l'onglet uniquement. Dans
          les vues filtrées (dossier ouvert, catégorie, « voir tout »), ces
          filtres n'opèrent plus sur le contenu affiché (une grille de
          dossier n'est pas filtrable par catégorie) — les garder affichés
          avec un élément actif en surface = un doublon au-dessus de la
          grille + des boutons sans effet. Le bouton « ← Accueil » en tête
          de page suffit à revenir. */}
      {!dossier && !category && !browseExternal && !browseGenre && (folders.length > 0 || (categories.data?.length ?? 0) > 1) && (
        <div className="mb-5 flex items-center gap-4 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {folders.map((folder) => (
            <button key={folder.id} type="button" onClick={() => openDossier(folder.slug)}
              className={`relative shrink-0 pb-0.5 text-sm font-bold transition ${dossier === folder.slug ? 'text-foreground' : 'text-muted hover:text-foreground/70'}`}>
              {folder.name}
              {dossier === folder.slug && <span className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-accent" aria-hidden />}
            </button>
          ))}
          {folders.length > 0 && (categories.data?.length ?? 0) > 1 && <span className="h-4 w-px shrink-0 bg-border" aria-hidden />}
          {!dossier && categories.data && categories.data.length > 1 && (
            <>
              <button type="button" onClick={() => setCategory(null)}
                className={`relative shrink-0 pb-0.5 text-sm font-bold transition ${category === null ? 'text-foreground' : 'text-muted hover:text-foreground/70'}`}>
                Tout
                {category === null && <span className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-accent" aria-hidden />}
              </button>
              {categories.data.map((entry) => (
                <button key={entry.name} type="button" onClick={() => { setCategory(category === entry.name ? null : entry.name); setBrowseExternal(false); setBrowseGenre(null); }}
                  className={`relative shrink-0 pb-0.5 text-sm font-bold transition ${category === entry.name ? 'text-foreground' : 'text-muted hover:text-foreground/70'}`}>
                  {/* Libellé nettoyé à l'écran, clé brute pour le filtre. */}
                  {entry.label ?? entry.name}
                  {category === entry.name && <span className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-accent" aria-hidden />}
                </button>
              ))}
            </>
          )}
        </div>
      )}
      <Suspense fallback={<div className="flex justify-center py-16"><Spinner /></div>}>
        {dossier
          ? <DossierView slug={dossier} q={q} folder={dossierFolder ?? (foldersQuery.isPending ? undefined : null)} />
          : !q && !category && !browseExternal && !browseGenre
            ? <VodHome kind={tab} onBrowseExternal={() => setBrowseExternal(true)} onBrowseGenre={(genre) => setBrowseGenre(genre)} folders={folders} />
            : browseExternal && !q
              ? <>
                  <h2 className="mb-4 text-xl font-bold">{tab === 'SERIES' ? 'Séries' : 'Films'} — tout le catalogue</h2>
                  <ExternalBrowse q="" kind={tab} />
                </>
              : browseGenre && !q
                ? <>
                    <h2 className="mb-4 text-xl font-bold">{browseGenre} — tout le catalogue</h2>
                    <ExternalBrowse q="" kind={tab} genre={browseGenre} />
                  </>
              : q ? (
                <VodSearch kind={tab} category={category} q={q} folders={folders} searchFolders={searchFolders} />
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
