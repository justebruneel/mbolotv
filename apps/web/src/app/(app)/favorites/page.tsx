'use client';

import type { Channel } from '@mbolo/contracts';
import { Icon, Skeleton } from '@mbolo/ui';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useFavorites } from '../../../shared/api/queries';
import { useFavoritesStore } from '../../../shared/stores/favorites';
import { ChannelTile } from '../../../features/live-tv/components/ChannelTile';

type Sort = 'recent' | 'alpha';
type Filter = 'all' | 'live' | 'down';

const PILL = 'rounded-full border px-3.5 py-1.5 text-xs font-bold transition';
const PILL_ON = 'border-accent bg-accent text-on-accent';
const PILL_OFF = 'border-border bg-surface text-muted hover:bg-surface-2 hover:text-foreground';

export default function FavoritesPage() {
  const favoritesQuery = useFavorites();
  const ids = useFavoritesStore((state) => state.ids);
  const queryClient = useQueryClient();
  const [sort, setSort] = useState<Sort>('recent');
  const [filter, setFilter] = useState<Filter>('all');

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
    const merged = [...pending, ...server.filter((channel) => wanted.has(channel.id))];
    return sort === 'alpha' ? [...merged].sort((a, b) => a.name.localeCompare(b.name, 'fr')) : merged;
  }, [favoritesQuery.data, ids, queryClient, sort]);

  const liveCount = favorites.filter((channel) => channel.nowPlaying).length;
  const downCount = favorites.filter((channel) => channel.healthStatus === 'DOWN').length;
  const shown =
    filter === 'live'
      ? favorites.filter((channel) => channel.nowPlaying)
      : filter === 'down'
        ? favorites.filter((channel) => channel.healthStatus === 'DOWN')
        : favorites;

  return (
    <main className="mx-auto max-w-[1600px] animate-fade-in px-4 py-6 md:px-10">
      {/* ===== En-tête : titre + tri ===== */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight md:text-3xl">Favoris</h1>
          <p className="mt-1 text-sm text-muted">
            {favorites.length === 0
              ? 'Aucune chaîne enregistrée'
              : `${favorites.length} chaîne${favorites.length > 1 ? 's' : ''}${liveCount > 0 ? ` · ${liveCount} en direct` : ''}`}
          </p>
        </div>
        {favorites.length > 1 && (
          <div className="flex items-center gap-2" role="group" aria-label="Trier les favoris">
            <button type="button" aria-pressed={sort === 'recent'} onClick={() => setSort('recent')} className={`${PILL} ${sort === 'recent' ? PILL_ON : PILL_OFF}`}>
              Récents
            </button>
            <button type="button" aria-pressed={sort === 'alpha'} onClick={() => setSort('alpha')} className={`${PILL} ${sort === 'alpha' ? PILL_ON : PILL_OFF}`}>
              A → Z
            </button>
          </div>
        )}
      </div>

      {/* ===== État serveur injoignable / accès perdu ===== */}
      {favoritesQuery.isError && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-5 py-4">
          <p className="text-sm text-muted">Liste indisponible — vérifie ta connexion ou ton code d’accès.</p>
          <button type="button" onClick={() => void favoritesQuery.refetch()} className={`${PILL} ${PILL_ON}`}>
            Réessayer
          </button>
        </div>
      )}

      {/* ===== Filtres ===== */}
      {favorites.length > 0 && (
        <div className="mb-5 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')} className={`${PILL} shrink-0 ${filter === 'all' ? PILL_ON : PILL_OFF}`}>
            Tous · {favorites.length}
          </button>
          <button type="button" aria-pressed={filter === 'live'} onClick={() => setFilter('live')} className={`${PILL} shrink-0 ${filter === 'live' ? PILL_ON : PILL_OFF}`}>
            <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-danger align-middle" aria-hidden />
            En direct · {liveCount}
          </button>
          {downCount > 0 && (
            <button type="button" aria-pressed={filter === 'down'} onClick={() => setFilter('down')} className={`${PILL} shrink-0 ${filter === 'down' ? PILL_ON : PILL_OFF}`}>
              Hors ligne · {downCount}
            </button>
          )}
        </div>
      )}

      {/* ===== Chargement : squelette (les tuiles font ~200px de large) ===== */}
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

      {/* ===== Vide : accroche vers le catalogue ===== */}
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

      {/* ===== Grille ===== */}
      {favorites.length > 0 && (
        <>
          {shown.length === 0 ? (
            <div className="py-14 text-center">
              <p className="text-sm text-muted">Aucune chaîne dans ce filtre.</p>
              <button type="button" onClick={() => setFilter('all')} className="mt-2 text-sm font-semibold text-accent hover:underline">
                Voir tous les favoris
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
              {shown.map((channel) => (
                <ChannelTile key={channel.id} channel={channel} />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
