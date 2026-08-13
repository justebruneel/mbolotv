'use client';

import { EmptyState, Spinner } from '@mbolo/ui';
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
      <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--mbolo-space-8)' }}>
        <Spinner />
      </div>
    );
  }

  return (
    <>
      <h1 className="pageTitle">Favoris</h1>
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
