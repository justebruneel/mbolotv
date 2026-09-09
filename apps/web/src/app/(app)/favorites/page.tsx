'use client';

import type { Channel, VodItem } from '@mbolo/contracts';
import { EmptyState, Icon, Skeleton } from '@mbolo/ui';
import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useFavorites, useExternalFavorites, useVodFavorites } from '../../../shared/api/queries';
import { useFavoritesStore } from '../../../shared/stores/favorites';
import { useVodFavoritesStore } from '../../../shared/stores/vodFavorites';
import { useExternalFavoritesStore, type ExternalFavoriteEntry } from '../../../shared/stores/externalFavorites';
import { useYoutubeFavoritesStore } from '../../../shared/stores/youtubeFavorites';
import { ChannelTile } from '../../../features/live-tv/components/ChannelTile';
import { MediaTile } from '../../../features/vod/components/MediaTile';
import { VodTile } from '../../../features/vod/components/VodTile';
import { YoutubeTile } from '../../../features/vod/components/YoutubeTile';
import { DragToRemove, TrashZone } from './DragToRemove';

type Tab = 'live' | 'vod';

// Onglet + recherche pilotés par l'URL (?tab=, ?q=) : HeaderSearch écrit q
// (debounce) en préservant tab — le retour navigateur restaure la vue exacte.
function isFavoritesTab(value: string | null): value is Tab | 'external' {
  return value === 'live' || value === 'vod' || value === 'external';
}

// « external » = ancien onglet Mbolo TV, fusionné dans « vod » : les anciens
// liens ?tab=external continuent d'ouvrir Films & Séries.
function normalizeTab(value: string | null): Tab {
  return value === 'live' ? 'live' : 'vod';
}

function FavoritesContent() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [tab, setTab] = useState<Tab>(() => normalizeTab(isFavoritesTab(tabParam) ? tabParam : null));

  // Retour/avant navigateur : l'onglet suit ?tab= (replaceState ne bascule pas
  // tout seul l'état, mais un vrai retour arrière restaure la vue exacte).
  useEffect(() => {
    if (isFavoritesTab(tabParam)) setTab(normalizeTab(tabParam));
  }, [tabParam]);

  return (
    <main className="mx-auto max-w-[1600px] animate-fade-in px-4 py-6 md:px-10">
      <h1 className="mb-5 text-2xl font-black tracking-tight md:text-3xl">Favoris</h1>

      {/* Barre d'onglets collante sous la barre d'app sur mobile : changer
          d'onglet sans remonter en haut ; statique sur desktop. */}
      <div
        role="tablist"
        aria-label="Type de favoris"
        className="sticky top-14 z-30 -mx-4 mb-5 flex flex-wrap items-center gap-2 border-b border-border bg-background/90 px-4 py-2.5 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none"
      >
        <TabButton active={tab === 'live'} label="Chaînes" icon={<Icon.Tv size={15} className="mr-1.5 inline align-[-2px]" />} onClick={() => { setTab('live'); setTabUrl('live'); }} />
        <TabButton active={tab === 'vod'} label="Films & Séries" icon={<Icon.Film size={15} className="mr-1.5 inline align-[-2px]" />} onClick={() => { setTab('vod'); setTabUrl('vod'); }} />
      </div>

      {tab === 'live' ? <LiveFavorites /> : <VodFavorites />}
      {/* Corbeille du retrait au glisser — un seul rendu par page, cible
          partagée par toutes les tuiles (store global DragToRemove). */}
      <TrashZone />
    </main>
  );
}

function TabButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-full px-4 py-2 text-sm font-semibold transition ${active ? 'bg-accent text-on-accent' : 'bg-surface text-muted hover:text-foreground'}`}
    >
      {icon}
      {label}
    </button>
  );
}

export default function FavoritesPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Skeleton className="h-8 w-40" /></div>}>
      <FavoritesContent />
    </Suspense>
  );
}

/** Change d'onglet en écrivant ?tab= (replace) : l'URL reflète la vue. */
function setTabUrl(next: Tab): void {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', next);
  window.history.replaceState(null, '', url.toString());
}

/** Recherche courante (?q=) partagée par les trois onglets. */
function useFavoritesQuery(): string {
  const searchParams = useSearchParams();
  return searchParams.get('q') ?? '';
}

/** Recherche active sans match : « Aucun résultat », pas « Aucun favori ». */
function NoResults({ query }: { query: string }) {
  return (
    <EmptyState
      title="Aucun résultat"
      hint={`Rien ne correspond à « ${query.trim()} » dans cette liste.`}
    />
  );
}

/** Compteur « X résultat(s) sur Y » pendant une recherche, sinon le total. */
function summaryLabel(shown: number, total: number, singular: string, plural: string): string {
  return shown === total
    ? total === 1 ? `${total} ${singular}` : `${total} ${plural}`
    : `${shown} résultat${shown > 1 ? 's' : ''} sur ${total}`;
}

function LiveFavorites() {
  const favoritesQuery = useFavorites();
  const ids = useFavoritesStore((state) => state.ids);
  const queryClient = useQueryClient();
  const query = useFavoritesQuery().trim().toLowerCase();
  const isSearching = query.length > 0;

  // Fusion optimiste : liste serveur (ordre récence) + ajouts pas encore
  // revenus du serveur — résolus depuis le cache de la page watch, donc
  // instantanés — moins les retraits déjà faits côté store. Recherche ?q=
  // (HeaderSearch) : filtre local par nom de chaîne.
  const favorites = useMemo(() => {
    const server = favoritesQuery.data?.items ?? [];
    const known = new Set(server.map((channel) => channel.id));
    const wanted = new Set(ids);
    const pending = ids
      .filter((id) => !known.has(id))
      .map((id) => queryClient.getQueryData<Channel>(['channel', id]))
      .filter((channel): channel is Channel => channel !== undefined && wanted.has(channel.id));
    return [...pending, ...server.filter((channel) => wanted.has(channel.id))];
  }, [favoritesQuery.data, ids, queryClient]);

  const visible = useMemo(() => {
    if (!isSearching) return favorites;
    return favorites.filter((channel) => channel.name.toLowerCase().includes(query));
  }, [favorites, query, isSearching]);

  return (
    <>
      <p className="mb-5 text-sm text-muted">
        {summaryLabel(visible.length, favorites.length, 'chaîne', 'chaînes')}
      </p>

      {favoritesQuery.isError && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-5 py-4">
          <p className="text-sm text-muted">Liste indisponible — vérifie ta connexion ou ton code d’accès.</p>
          <button type="button" onClick={() => void favoritesQuery.refetch()} className="rounded-full border border-accent bg-accent px-3.5 py-1.5 text-xs font-bold text-on-accent">
            Réessayer
          </button>
        </div>
      )}

      {favoritesQuery.isLoading && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index}>
              <Skeleton className="aspect-[4/3] w-full rounded-xl sm:aspect-[16/10]" />
              <Skeleton className="mt-2 h-3.5 w-3/4 rounded" />
            </div>
          ))}
        </div>
      )}

      {!favoritesQuery.isLoading && visible.length === 0 && (isSearching ? (
        <NoResults query={query} />
      ) : (
        <div className="mx-auto max-w-md animate-scale-in py-16 text-center">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-surface-2">
            <Icon.Heart size={36} className="text-muted" />
          </div>
          <h2 className="text-xl font-bold">Aucun favori</h2>
          <p className="mt-2 text-sm text-muted">Touche le cœur sur une chaîne pour la retrouver ici, en direct comme en déplacement.</p>
          <Link
            href="/live"
            className="mt-6 inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-bold text-on-accent transition hover:bg-accent/90"
          >
            <Icon.Tv size={16} aria-hidden /> Parcourir les chaînes
          </Link>
        </div>
      ))}

      {visible.length > 0 && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
          {visible.map((channel) => (
            <DragToRemove key={channel.id} label={channel.name} onRemove={() => useFavoritesStore.getState().toggle(channel.id)}>
              <ChannelTile channel={channel} />
            </DragToRemove>
          ))}
        </div>
      )}
    </>
  );
}

function VodFavorites() {
  const vodFavoritesQuery = useVodFavorites();
  const externalFavoritesQuery = useExternalFavorites();
  const ids = useVodFavoritesStore((state) => state.ids);
  const queryClient = useQueryClient();
  const ytEntries = useYoutubeFavoritesStore((state) => state.entries);
  // Favoris Mbolo TV (titres externes, fiche /vod/x) : local-first + serveur —
  // la liste serveur de l'appareil fait foi pour l'appartenance, les entrées
  // locales fournissent les métadonnées (et gardent les fiches lisibles même
  // hors ligne). Affichées dans ce même onglet puisqu'il porte le catalogue.
  const externalEntries = useExternalFavoritesStore((state) => state.entries);
  const query = useFavoritesQuery().trim().toLowerCase();
  const isSearching = query.length > 0;

  const ytFavorites = useMemo(() => {
    const sorted = [...ytEntries].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
    if (!isSearching) return sorted;
    return sorted.filter((entry) => entry.title.toLowerCase().includes(query));
  }, [ytEntries, query, isSearching]);

  // Fusion optimiste : liste serveur (ordre récence serveur) + ajouts locaux
  // pas encore confirmés — l'ordre local (du plus récent au plus ancien) vient
  // en tête, puis le serveur fait foi. Entrée locale préférée quand elle
  // existe (métadonnées capturées sur la fiche), sinon reconstruction.
  const externalFavorites = useMemo<ExternalFavoriteEntry[]>(() => {
    const server = externalFavoritesQuery.data?.items ?? [];
    const known = new Set(server.map((item) => item.id));
    const pending = externalEntries
      .filter((entry) => !known.has(entry.id))
      .sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
    const localByRawId = new Map(externalEntries.map((entry) => [entry.id, entry]));
    const fromServer: ExternalFavoriteEntry[] = server.map((item) => {
      const local = localByRawId.get(item.id);
      return local ?? { id: item.id, title: item.title, posterUrl: item.posterUrl, kind: item.kind, year: item.year, addedAt: '' };
    });
    return [...pending, ...fromServer];
  }, [externalEntries, externalFavoritesQuery.data]);

  const favorites = useMemo(() => {
    const server = vodFavoritesQuery.data?.items ?? [];
    const known = new Set(server.map((item) => item.id));
    const wanted = new Set(ids);
    const pending = ids
      .filter((id) => !known.has(id))
      .map((id) => queryClient.getQueryData<VodItem>(['vod-item', id]))
      .filter((item): item is VodItem => item !== undefined && wanted.has(item.id));
    return [...pending, ...server.filter((item) => wanted.has(item.id))];
  }, [vodFavoritesQuery.data, ids, queryClient]);

  const visibleFavs = useMemo(() => {
    if (!isSearching) return favorites;
    return favorites.filter((item) => item.title.toLowerCase().includes(query));
  }, [favorites, query, isSearching]);

  const visibleYt = useMemo(() => {
    if (!isSearching) return ytFavorites;
    return ytFavorites.filter((entry) => entry.title.toLowerCase().includes(query));
  }, [ytFavorites, query, isSearching]);

  const visibleExternals = useMemo(() => {
    if (!isSearching) return externalFavorites;
    return externalFavorites.filter((entry) => entry.title.toLowerCase().includes(query));
  }, [externalFavorites, query, isSearching]);

  if (vodFavoritesQuery.isLoading) {
    return (
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index}>
            <Skeleton className="aspect-[2/3] w-full rounded-xl" />
            <Skeleton className="mt-2 h-3.5 w-3/4 rounded" />
          </div>
        ))}
      </div>
    );
  }

  const hasAny = favorites.length > 0 || ytFavorites.length > 0 || externalFavorites.length > 0;

  // Nollywood (favoris YouTube locaux) sous le catalogue VOD — section
  // muette si vide (le reste de l'onglet reste lisible seul).
  if (!hasAny) {
    return isSearching ? (
      <NoResults query={query} />
    ) : (
      <EmptyState
        title="Aucun favori film ou série ajouté"
        hint="Touche le cœur sur une affiche dans Films & Séries pour la retrouver ici."
        action={
          <Link
            href="/vod"
            className="mt-6 inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-bold text-on-accent transition hover:bg-accent/90"
          >
            <Icon.Film size={16} aria-hidden /> Parcourir les films & séries
          </Link>
        }
      />
    );
  }

  const summary = isSearching
    ? summaryLabel(visibleFavs.length + visibleYt.length + visibleExternals.length, favorites.length + ytFavorites.length + externalFavorites.length, 'favori', 'favoris')
    : [
        favorites.length > 0 && `${favorites.length} film${favorites.length > 1 ? 's' : ''} & série${favorites.length > 1 ? 's' : ''}`,
        externalFavorites.length > 0 && `${externalFavorites.length} titre${externalFavorites.length > 1 ? 's' : ''}`,
        ytFavorites.length > 0 && `${ytFavorites.length} Nollywood`,
      ].filter(Boolean).join(' · ');

  return (
    <>
      <p className="mb-5 text-sm text-muted">{summary}</p>
      {visibleFavs.length > 0 && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
          {visibleFavs.map((item) => (
            <DragToRemove key={item.id} label={item.title} onRemove={() => useVodFavoritesStore.getState().toggle(item.id)}>
              <VodTile item={item} />
            </DragToRemove>
          ))}
        </div>
      )}
      {visibleExternals.length > 0 && (
        <section className={visibleFavs.length > 0 ? 'mt-8' : ''} aria-label="Favoris Mbolo TV">
          {externalFavoritesQuery.isError && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-5 py-4">
              <p className="text-sm text-muted">Sync indisponible — tes favoris locaux restent affichés ici.</p>
              <button type="button" onClick={() => void externalFavoritesQuery.refetch()} className="rounded-full border border-accent bg-accent px-3.5 py-1.5 text-xs font-bold text-on-accent">
                Réessayer
              </button>
            </div>
          )}
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {visibleExternals.map((entry) => (
              <DragToRemove
                key={entry.id}
                label={entry.title}
                onRemove={() => useExternalFavoritesStore.getState().remove(entry.id)}
              >
                <MediaTile
                  href={`/vod/x/${entry.id}`}
                  ariaLabel={`Ouvrir la fiche de ${entry.title}`}
                  aspect="poster"
                  imageUrl={entry.posterUrl}
                  title={entry.title}
                  subtitle={entry.year != null ? String(entry.year) : undefined}
                />
              </DragToRemove>
            ))}
          </div>
        </section>
      )}
      {visibleYt.length > 0 && (
        <section className={visibleFavs.length > 0 || visibleExternals.length > 0 ? 'mt-8' : ''} aria-label="Favoris Nollywood">
          <h2 className="mb-3 text-lg font-bold">Nollywood</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {visibleYt.map((entry) => (
              <DragToRemove
                key={entry.id}
                label={entry.title}
                onRemove={() => useYoutubeFavoritesStore.getState().remove(entry.id)}
              >
                <YoutubeTile
                  item={{ id: entry.id, title: entry.title, posterUrl: entry.posterUrl, description: null, publishedAt: null, duration: null }}
                />
              </DragToRemove>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

// Favoris Mbolo TV (titres externes) fusionnés dans l'onglet Films & Séries
// (VodFavorites) : c'est là que les cœurs posés sur les fiches /vod/x
// atterrissent réellement — l'onglet séparé rendait la liste invisible.
