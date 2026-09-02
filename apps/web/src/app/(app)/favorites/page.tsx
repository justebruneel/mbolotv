'use client';

import type { Channel, VodItem } from '@mbolo/contracts';
import { EmptyState, Icon, Skeleton } from '@mbolo/ui';
import Link from 'next/link';
import { Suspense, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useFavorites, useVodFavorites } from '../../../shared/api/queries';
import { useFavoritesStore } from '../../../shared/stores/favorites';
import { useVodFavoritesStore } from '../../../shared/stores/vodFavorites';
import { ChannelTile } from '../../../features/live-tv/components/ChannelTile';
import { VodTile } from '../../../features/vod/components/VodTile';

type Tab = 'live' | 'vod';

export default function FavoritesPage() {
  const [tab, setTab] = useState<Tab>('live');

  return (
    <main className="mx-auto max-w-[1600px] animate-fade-in px-4 py-6 md:px-10">
      <div className="mb-5 flex flex-wrap items-center gap-2" role="tablist" aria-label="Type de favoris">
        <button type="button" role="tab" aria-selected={tab === 'live'} onClick={() => setTab('live')}
          className={`rounded-full px-4 py-2 text-sm font-semibold transition ${tab === 'live' ? 'bg-accent text-on-accent' : 'bg-surface text-muted hover:text-foreground'}`}>
          <Icon.Tv size={15} className="mr-1.5 inline align-[-2px]" /> Chaînes
        </button>
        <button type="button" role="tab" aria-selected={tab === 'vod'} onClick={() => setTab('vod')}
          className={`rounded-full px-4 py-2 text-sm font-semibold transition ${tab === 'vod' ? 'bg-accent text-on-accent' : 'bg-surface text-muted hover:text-foreground'}`}>
          <Icon.Film size={15} className="mr-1.5 inline align-[-2px]" /> Films & Séries
        </button>
      </div>
      {tab === 'live' ? (
        <Suspense fallback={null}>
          <LiveFavorites />
        </Suspense>
      ) : (
        <Suspense fallback={null}>
          <VodFavorites />
        </Suspense>
      )}
    </main>
  );
}

function LiveFavorites() {
  const favoritesQuery = useFavorites();
  const ids = useFavoritesStore((state) => state.ids);
  const queryClient = useQueryClient();

  // Fusion optimiste : liste serveur (ordre récence) + ajouts pas encore
  // revenus du serveur — résolus depuis le cache de la page watch, donc
  // instantanés — moins les retraits déjà faits côté store.
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

  if (favorites.length === 0) {
    return (
      <EmptyState
        title="Aucun favori VOD"
        hint="Touche le cœur sur une affiche dans Films & Séries pour la retrouver ici."
      />
    );
  }

  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
      {favorites.map((item) => (
        <VodTile key={item.id} item={item} />
      ))}
    </div>
  );
}
