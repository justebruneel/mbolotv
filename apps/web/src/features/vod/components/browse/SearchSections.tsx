'use client';

import { EmptyState, Spinner } from '@mbolo/ui';
import type { VodFolderSummary } from '@mbolo/contracts';
import { useCallback, useEffect, useState } from 'react';
import {
  YOUTUBE_AFOREVO_CHANNEL_ID,
  useInfiniteExternalTitles,
  useInfiniteMergedYoutube,
  useInfiniteYoutube,
} from '../../../../shared/api/queries';
import { useInfiniteScroll } from '../../../../shared/hooks/useInfiniteScroll';
import { Tab, dedupeYoutubeItems } from '../../vodUtils';
import { ExternalTile } from '../ExternalTile';
import { YoutubeTile } from '../YoutubeTile';
import { FolderVodBrowse, MergedYoutubeBrowse, VodBrowse, YoutubeBrowse, useSectionSettled } from './BrowseGrids';

export interface SearchSection {
  id: string;
  name: string;
  channelIds: string[];
}

// Section recherche des titres externes (première page, silencieuse si vide),
// avec « Voir plus » qui déplie la grille complète (défilement infini).
export function ExternalSearch({ q, kind, onSettled }: { q: string; kind: 'MOVIE' | 'SERIES'; onSettled?: (empty: boolean) => void }) {
  const query = useInfiniteExternalTitles(q, 12, kind);
  const [expanded, setExpanded] = useState(false);
  const items = query.data?.pages[0]?.items ?? [];
  const all = query.data?.pages.flatMap((page) => page.items) ?? [];
  const { sentinelRef, isFetchingNextPage } = useInfiniteScroll(query);

  useSectionSettled(onSettled, !query.isLoading && !query.isPlaceholderData, query.isError || items.length === 0);
  if (query.isLoading || query.isError) return null;
  if (items.length === 0) return null;
  const shown = expanded ? all : items;
  return (
    <section className="mt-10" aria-label="Résultats titres externes">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold">{kind === 'SERIES' ? 'Séries' : 'Films'}</h2>
        {!expanded && (
          <button type="button" onClick={() => setExpanded(true)} className="text-xs font-semibold text-muted hover:text-accent">
            Voir plus
          </button>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {shown.map((item) => <ExternalTile key={item.id} item={item} />)}
      </div>
      {expanded && <div ref={sentinelRef} className="h-10" />}
      {expanded && isFetchingNextPage && <div className="flex justify-center py-4"><Spinner /></div>}
    </section>
  );
}

// Section YouTube d'un dossier en mode recherche : le titre de section ne
// s'affiche QUE si la recherche a des résultats. « Voir plus » déplie la
// grille entière (défilement infini).
export function FolderSearchSection({ section, q, onSettled }: { section: SearchSection; q: string; onSettled?: (empty: boolean) => void }) {
  const query = useInfiniteMergedYoutube(section.channelIds, 25, q);
  const [expanded, setExpanded] = useState(false);
  const items = dedupeYoutubeItems(query.data?.pages[0]?.items ?? []);
  const all = dedupeYoutubeItems(query.data?.pages.flatMap((page) => page.items) ?? []);
  const { sentinelRef, isFetchingNextPage } = useInfiniteScroll(query);

  useSectionSettled(onSettled, !query.isLoading && !query.isPlaceholderData, query.isError || items.length === 0);
  if (items.length === 0) return null;
  const shown = expanded ? all : items;
  return (
    <section className="mt-10" aria-label={`Résultats ${section.name}`}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold">{section.name}</h2>
        {!expanded && (
          <button type="button" onClick={() => setExpanded(true)} className="text-xs font-semibold text-muted hover:text-accent">
            Voir plus
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {shown.map((item) => <YoutubeTile key={item.id} item={item} />)}
      </div>
      {expanded && <div ref={sentinelRef} className="h-10" />}
      {expanded && isFetchingNextPage && <div className="flex justify-center py-4"><Spinner /></div>}
    </section>
  );
}

// Section Nollywood (repli hors dossier) en mode recherche — muette si vide.
export function NollywoodSearchSection({ q, onSettled }: { q: string; onSettled?: (empty: boolean) => void }) {
  const query = useInfiniteYoutube(YOUTUBE_AFOREVO_CHANNEL_ID, 25, q);
  const [expanded, setExpanded] = useState(false);
  const items = dedupeYoutubeItems(query.data?.pages[0]?.items ?? []);
  const all = dedupeYoutubeItems(query.data?.pages.flatMap((page) => page.items) ?? []);
  const { sentinelRef, isFetchingNextPage } = useInfiniteScroll(query);

  useSectionSettled(onSettled, !query.isLoading && !query.isPlaceholderData, query.isError || items.length === 0);
  if (items.length === 0) return null;
  const shown = expanded ? all : items;
  return (
    <section className="mt-10" aria-label="Résultats Nollywood">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold">Nollywood</h2>
        {!expanded && (
          <button type="button" onClick={() => setExpanded(true)} className="text-xs font-semibold text-muted hover:text-accent">
            Voir plus
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {shown.map((item) => <YoutubeTile key={item.id} item={item} />)}
      </div>
      {expanded && <div ref={sentinelRef} className="h-10" />}
      {expanded && isFetchingNextPage && <div className="flex justify-center py-4"><Spinner /></div>}
    </section>
  );
}

// Recherche unifiée Films & Séries : quatre sources potentielles (catalogue
// Xtream, titres externes, un rail YouTube par dossier — ou Nollywood en
// repli). Chacune est MUETTE quand elle ne trouve rien, y compris son
// en-tête. L'état vide n'est que GLOBAL : affiché uniquement quand TOUTES les
// sources attendues ont répondu vides.
export function VodSearch({ kind, category, q, folders, searchFolders }: {
  kind: Tab;
  category: string | null;
  q: string;
  folders: VodFolderSummary[];
  searchFolders: SearchSection[];
}) {
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
// déjà office de titre. La grille occupe l'espace, c'est tout.
export function DossierView({ slug, q, folder }: { slug: string; q: string; folder: VodFolderSummary | null | undefined }) {
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