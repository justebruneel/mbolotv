'use client';

import type { Channel, VodItem } from '@mbolo/contracts';
import { EmptyState, Icon, Skeleton } from '@mbolo/ui';
import Link from 'next/link';
import { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useFavorites, useVodFavorites } from '../../../shared/api/queries';
import { useFavoritesStore } from '../../../shared/stores/favorites';
import { useVodFavoritesStore } from '../../../shared/stores/vodFavorites';
import { useExternalFavoritesStore } from '../../../shared/stores/externalFavorites';
import { useYoutubeFavoritesStore } from '../../../shared/stores/youtubeFavorites';
import { ChannelTile } from '../../../features/live-tv/components/ChannelTile';
import { VodTile } from '../../../features/vod/components/VodTile';
import { YoutubeTile } from '../../../features/vod/components/YoutubeTile';

type Tab = 'live' | 'vod' | 'external';

// Tuile affiche 2:3 d'un favori externe : même coquille qu'ExternalTile mais
// rendue depuis les métadonnées capturées au cœur (aucun fetch, hors ligne
// compris) — les détails (durée, casting…) restent sur la fiche.
function ExternalFavoriteTile({ entry }: { entry: ExternalFavoriteEntryLite }) {
  return (
    <article className="group relative min-w-0">
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl border border-border bg-surface transition-[transform,border-color,box-shadow] duration-300 group-hover:-translate-y-1 group-hover:border-accent/50 group-hover:shadow-lg">
        <Link href={`/vod/x/${entry.id}`} aria-label={`Ouvrir la fiche de ${entry.title}`} className="block h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset">
          {entry.posterUrl ? (
            <img src={entry.posterUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
          ) : (
            <div className="flex h-full items-center justify-center bg-gradient-to-br from-surface-2 to-surface text-muted/40">
              <Icon.Film size={36} />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
          <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-300 group-hover:opacity-100">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-on-accent shadow-lg transition-transform duration-200 group-hover:scale-110">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            </div>
          </div>
        </Link>
      </div>
      <div className="mt-2 px-0.5">
        <p className="line-clamp-2 text-[13px] font-semibold leading-tight text-foreground transition-colors duration-200 group-hover:text-accent">{entry.title}</p>
        {entry.year != null && <p className="mt-0.5 truncate text-[11px] text-muted">{entry.year}</p>}
      </div>
    </article>
  );
}

interface ExternalFavoriteEntryLite {
  id: string;
  title: string;
  posterUrl: string | null;
  year: number | null;
}

// Onglet + recherche pilotés par l'URL (?tab=, ?q=) : HeaderSearch écrit q
// (debounce) en préservant tab — le retour navigateur restaure la vue exacte.
function isFavoritesTab(value: string | null): value is Tab {
  return value === 'live' || value === 'vod' || value === 'external';
}

function FavoritesContent() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [tab, setTab] = useState<Tab>(() => (isFavoritesTab(tabParam) ? tabParam : 'live'));

  return (
    <main className="mx-auto max-w-[1600px] animate-fade-in px-4 py-6 md:px-10">
      <div className="mb-5 flex flex-wrap items-center gap-2" role="tablist" aria-label="Type de favoris">
        <button type="button" role="tab" aria-selected={tab === 'live'} onClick={() => { setTab('live'); setTabUrl('live'); }}
          className={`rounded-full px-4 py-2 text-sm font-semibold transition ${tab === 'live' ? 'bg-accent text-on-accent' : 'bg-surface text-muted hover:text-foreground'}`}>
          <Icon.Tv size={15} className="mr-1.5 inline align-[-2px]" /> Chaînes
        </button>
        <button type="button" role="tab" aria-selected={tab === 'vod'} onClick={() => { setTab('vod'); setTabUrl('vod'); }}
          className={`rounded-full px-4 py-2 text-sm font-semibold transition ${tab === 'vod' ? 'bg-accent text-on-accent' : 'bg-surface text-muted hover:text-foreground'}`}>
          <Icon.Film size={15} className="mr-1.5 inline align-[-2px]" /> Films & Séries
        </button>
        <button type="button" role="tab" aria-selected={tab === 'external'} onClick={() => { setTab('external'); setTabUrl('external'); }}
          className={`rounded-full px-4 py-2 text-sm font-semibold transition ${tab === 'external' ? 'bg-accent text-on-accent' : 'bg-surface text-muted hover:text-foreground'}`}>
          <Icon.Heart size={15} className="mr-1.5 inline align-[-2px]" /> Mbolo TV
        </button>
      </div>
      {tab === 'live' ? (
        <Suspense fallback={null}>
          <LiveFavorites />
        </Suspense>
      ) : tab === 'vod' ? (
        <Suspense fallback={null}>
          <VodFavorites />
        </Suspense>
      ) : (
        <ExternalFavorites />
      )}
    </main>
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

function LiveFavorites() {
  const favoritesQuery = useFavorites();
  const ids = useFavoritesStore((state) => state.ids);
  const queryClient = useQueryClient();
  const query = useFavoritesQuery().trim().toLowerCase();

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
    const merged = [...pending, ...server.filter((channel) => wanted.has(channel.id))];
    if (!query) return merged;
    return merged.filter((channel) => channel.name.toLowerCase().includes(query));
  }, [favoritesQuery.data, ids, queryClient, query]);

  return (
    <>
      <div className="mb-5">
        <h1 className="text-2xl font-black tracking-tight md:text-3xl">Favoris</h1>
        <p className="mt-1 text-sm text-muted">
          {favorites.length === 0 ? 'Aucune chaîne enregistrée' : `${favorites.length} chaîne${favorites.length > 1 ? 's' : ''}`}
        </p>
      </div>

      {favoritesQuery.isError && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-5 py-4">
          <p className="text-sm text-muted">Liste indisponible — vérifie ta connexion ou ton code d’accès.</p>
          <button type="button" onClick={() => void favoritesQuery.refetch()} className="rounded-full border border-accent bg-accent px-3.5 py-1.5 text-xs font-bold text-on-accent">
            Réessayer
          </button>
        </div>
      )}

      {favoritesQuery.isLoading && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index}>
              <Skeleton className="aspect-[4/3] w-full rounded-xl sm:aspect-[16/10]" />
              <Skeleton className="mt-2 h-3.5 w-3/4 rounded" />
            </div>
          ))}
        </div>
      )}

      {!favoritesQuery.isLoading && favorites.length === 0 && (
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
      )}

      {favorites.length > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
          {favorites.map((channel) => (
            <ChannelTile key={channel.id} channel={channel} />
          ))}
        </div>
      )}
    </>
  );
}

function VodFavorites() {
  const vodFavoritesQuery = useVodFavorites();
  const ids = useVodFavoritesStore((state) => state.ids);
  const queryClient = useQueryClient();
  const ytEntries = useYoutubeFavoritesStore((state) => state.entries);
  const query = useFavoritesQuery().trim().toLowerCase();

  const ytFavorites = useMemo(() => {
    const sorted = [...ytEntries].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
    if (!query) return sorted;
    return sorted.filter((entry) => entry.title.toLowerCase().includes(query));
  }, [ytEntries, query]);

  const favorites = useMemo(() => {
    const server = vodFavoritesQuery.data?.items ?? [];
    const known = new Set(server.map((item) => item.id));
    const wanted = new Set(ids);
    const pending = ids
      .filter((id) => !known.has(id))
      .map((id) => queryClient.getQueryData<VodItem>(['vod-item', id]))
      .filter((item): item is VodItem => item !== undefined && wanted.has(item.id));
    const merged = [...pending, ...server.filter((item) => wanted.has(item.id))];
    if (!query) return merged;
    return merged.filter((item) => item.title.toLowerCase().includes(query));
  }, [vodFavoritesQuery.data, ids, queryClient, query]);

  if (vodFavoritesQuery.isLoading) {
    return (
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index}>
            <Skeleton className="aspect-[2/3] w-full rounded-xl" />
            <Skeleton className="mt-2 h-3.5 w-3/4 rounded" />
          </div>
        ))}
      </div>
    );
  }

  // Nollywood (favoris YouTube locaux) sous le catalogue VOD — section
  // muette si vide (le reste de l'onglet reste lisible seul).
  if (favorites.length === 0 && ytFavorites.length === 0) {
    return (
      <EmptyState
        title="Aucun favori VOD"
        hint="Touche le cœur sur une affiche dans Films & Séries pour la retrouver ici."
      />
    );
  }

  return (
    <>
      {favorites.length > 0 && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
          {favorites.map((item) => (
            <VodTile key={item.id} item={item} />
          ))}
        </div>
      )}
      {ytFavorites.length > 0 && (
        <section className="mt-8" aria-label="Favoris Nollywood">
          <h2 className="mb-3 text-lg font-bold">Nollywood</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {ytFavorites.map((entry) => (
              <YoutubeTile
                key={entry.id}
                item={{ id: entry.id, title: entry.title, posterUrl: entry.posterUrl, description: null, publishedAt: null, duration: null }}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

// Favoris Mbolo TV (titres externes) : rendus depuis les métadonnées du
// store local — aucun fetch, disponible hors ligne. Recherche par titre,
// pilotée par ?q= (HeaderSearch de la barre).
function ExternalFavorites() {
  const entries = useExternalFavoritesStore((state) => state.entries);
  const query = useFavoritesQuery().trim().toLowerCase();

  const favorites = useMemo(() => {
    const sorted = [...entries].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
    if (!query) return sorted;
    return sorted.filter((entry) => entry.title.toLowerCase().includes(query));
  }, [entries, query]);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight md:text-3xl">Favoris</h1>
          <p className="mt-1 text-sm text-muted">
            {entries.length === 0 ? 'Aucun titre enregistré' : `${entries.length} titre${entries.length > 1 ? 's' : ''}`}
          </p>
        </div>
      </div>

      {entries.length === 0 && (
        <div className="mx-auto max-w-md animate-scale-in py-16 text-center">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-surface-2">
            <Icon.Heart size={36} className="text-muted" />
          </div>
          <h2 className="text-xl font-bold">Aucun favori</h2>
          <p className="mt-2 text-sm text-muted">Sur une fiche Films & Séries, touche le cœur à côté du bouton Lecture pour garder le titre ici.</p>
          <Link
            href="/vod"
            className="mt-6 inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-bold text-on-accent transition hover:bg-accent/90"
          >
            <Icon.Film size={16} aria-hidden /> Parcourir les films & séries
          </Link>
        </div>
      )}

      {entries.length > 0 && favorites.length === 0 && (
        <EmptyState title="Aucun résultat" hint={`Aucun titre ne correspond à « ${query.trim()} ».`} />
      )}

      {favorites.length > 0 && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
          {favorites.map((entry) => (
            <ExternalFavoriteTile key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </>
  );
}
