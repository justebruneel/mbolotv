'use client';

import { EmptyState, Icon, Spinner } from '@mbolo/ui';
import type { VodFolderSummary } from '@mbolo/contracts';
import { useMemo } from 'react';
import {
  YOUTUBE_AFOREVO_CHANNEL_ID,
  useExternalGenres,
  useInfiniteExternalTitles,
  useInfiniteMergedYoutube,
  useInfiniteYoutube,
  useVodFolderRows,
  useVodHero,
  useVodRows,
} from '../../../../shared/api/queries';
import { useSettingsStore } from '../../../../shared/stores/settings';
import { formatTime } from '../../../../shared/utils/formatTime';
import { NOLLYWOOD_DOSSIER_HREF, Tab, dedupeYoutubeItems, dossierHref, resumeHref } from '../../vodUtils';
import { VodHero } from '../VodHero';
import { VodRow } from '../VodRow';
import { ExternalRow } from '../ExternalRow';
import { YoutubeRow } from '../YoutubeRow';
import { RetryButton } from '../RetryButton';
import { SkeletonHome } from '../Skeletons';

// Rangée « Reprendre » : derniers contenus regardés, triés par repositionnement.
export function ResumeRow() {
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
function FolderOnly({ folders, tab }: { folders: VodFolderSummary[]; tab: Tab }) {
  return (
    <>
      {folders.map((folder) => <FolderRail key={folder.id} folder={folder} tab={tab} />)}
    </>
  );
}

// Repli garanti (pas de dossiers en base) : l'ancienne page « Nollywood seul »
// sur l'onglet Films. suppressEmpty : quand une autre source (titres externes)
// porte déjà la page, on se tait au lieu d'afficher un « Aucun résultat ».
function NollywoodOnly({ suppressEmpty = false }: { suppressEmpty?: boolean }) {
  const query = useInfiniteYoutube(YOUTUBE_AFOREVO_CHANNEL_ID, 25, '');
  const items = dedupeYoutubeItems(query.data?.pages[0]?.items ?? []);
  if (query.isLoading) return <div className="flex justify-center py-16"><Spinner /></div>;
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
// sources (dossiers YouTube, titres externes) portent la page.
function VodHomeEmpty({ kind, onBrowseExternal, onBrowseGenre, folders }: { kind: 'MOVIE' | 'SERIES'; onBrowseExternal: () => void; onBrowseGenre: (genre: string) => void; folders: VodFolderSummary[] }) {
  const externalPreview = useInfiniteExternalTitles('', 12, kind, undefined, 'year');
  const externalItems = (externalPreview.data?.pages[0]?.items ?? []).slice(0, 12);
  const hasExternal = externalItems.length > 0;
  const isExternalLoading = externalPreview.isLoading;
  const genresQuery = useExternalGenres(kind);
  const hasGenres = (genresQuery.data?.genres ?? []).length > 0;
  const isGenresLoading = genresQuery.isLoading;
  const externalTitle = kind === 'SERIES' ? 'Séries — Nouveau sur Mbolo' : 'Nouveau sur Mbolo';

  if (folders.length > 0) {
    return (
      <>
        <FolderOnly folders={folders} tab={kind} />
        {hasExternal && <ExternalRow title={externalTitle} items={externalItems} onSeeAll={onBrowseExternal} />}
        <ExternalGenreRails kind={kind} onBrowseGenre={onBrowseGenre} />
      </>
    );
  }

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
export function VodHome({ kind, onBrowseExternal, onBrowseGenre, folders }: { kind: 'MOVIE' | 'SERIES'; onBrowseExternal: () => void; onBrowseGenre: (genre: string) => void; folders: VodFolderSummary[] }) {
  const heroQuery = useVodHero(kind);
  const rowsQuery = useVodRows(kind);

  if (heroQuery.isLoading || rowsQuery.isLoading) return <SkeletonHome />;
  if (rowsQuery.isError || heroQuery.isError) return (
    <EmptyState
      title="Catalogue indisponible"
      hint="Réessayez dans quelques instants."
      action={<RetryButton onRetry={() => { void heroQuery.refetch(); void rowsQuery.refetch(); }} />}
    />
  );

  const hero = heroQuery.data?.items ?? [];
  const rows = rowsQuery.data?.rows ?? [];
  if (rows.length === 0 && hero.length === 0) {
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
      <ExternalRail onBrowseAll={onBrowseExternal} kind={kind} />
      <ExternalGenreRails kind={kind} onBrowseGenre={onBrowseGenre} />
    </>
  );
}

// Rail d'accueil des titres externes (lecteurs tiers) : aperçu silencieux.
// « Nouveau sur Mbolo » (films) / « Séries — Nouveau sur Mbolo » selon
// l'onglet — trié par date de sortie (année DESC) : les sorties récentes,
// pas les derniers imports. « Voir tout » bascule la grille paginée.
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