'use client';

import { EmptyState, Spinner } from '@mbolo/ui';
import { useMemo } from 'react';
import { useChannels } from '../../../shared/api/queries';
import { useFavoritesStore } from '../../../shared/stores/favorites';
import { ChannelGrid } from '../../../features/live-tv/components/ChannelGrid';
import { PageHeader } from '../../../shared/components/PageHeader';

export default function FavoritesPage() {
  const ids = useFavoritesStore((state) => state.ids);
  const channelsQuery = useChannels({ limit: 100 });

  const favorites = useMemo(
    () => (channelsQuery.data?.items ?? []).filter((channel) => ids.includes(channel.id)),
    [channelsQuery.data, ids],
  );

  if (channelsQuery.isLoading) {
    return (
      <div className="flex justify-center p-12">
        <Spinner />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Favoris"
        description={favorites.length > 0 ? `${favorites.length} chaîne(s) enregistrée(s).` : undefined}
      />
      {favorites.length === 0 ? (
        <EmptyState
          title="Aucun favori"
          hint="Ajoutez des chaînes à vos favoris depuis le catalogue Live TV."
        />
      ) : (
        <ChannelGrid channels={favorites} />
      )}
    </>
  );
}
