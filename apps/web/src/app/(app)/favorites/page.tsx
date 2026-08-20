'use client';

import { EmptyState, Icon, Spinner } from '@mbolo/ui';
import Link from 'next/link';
import { useMemo } from 'react';
import { useChannels } from '../../../shared/api/queries';
import { useFavoritesStore } from '../../../shared/stores/favorites';
import { ChannelGrid } from '../../../features/live-tv/components/ChannelGrid';

export default function FavoritesPage() {
  const ids = useFavoritesStore((state) => state.ids);
  const channelsQuery = useChannels({ limit: 100 });

  const favorites = useMemo(
    () => (channelsQuery.data?.items ?? []).filter((channel) => ids.includes(channel.id)),
    [channelsQuery.data, ids],
  );

  if (channelsQuery.isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="mb-8 animate-slide-up">
        <h1 className="text-3xl font-extrabold tracking-tight">Favoris</h1>
        {favorites.length > 0 && (
          <p className="mt-1 text-secondary">
            {favorites.length} chaîne{favorites.length > 1 ? 's' : ''} enregistrée{favorites.length > 1 ? 's' : ''}
          </p>
        )}
      </div>

      {favorites.length === 0 ? (
        <div className="animate-scale-in">
          <div className="mx-auto max-w-md text-center py-16">
            <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-surface-2">
              <Icon.Heart size={36} className="text-muted" />
            </div>
            <h2 className="text-xl font-bold">Aucun favori</h2>
            <p className="mt-2 text-secondary">
              Ajoutez des chaînes à vos favoris depuis le catalogue Live TV.
            </p>
            <Link
              href="/live"
              className="mt-6 inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent transition-all duration-200 hover:bg-accent-hover hover:shadow-lg hover:shadow-accent/20"
            >
              <Icon.Tv size={16} /> Parcourir les chaînes
            </Link>
          </div>
        </div>
      ) : (
        <ChannelGrid channels={favorites} />
      )}
    </div>
  );
}
