'use client';

import { Input, Spinner } from '@mbolo/ui';
import { useDeferredValue, useState } from 'react';
import { useCategories, useChannels } from '../../../shared/api/queries';
import { CategoryTabs } from '../../../features/live-tv/components/CategoryTabs';
import { ChannelGrid } from '../../../features/live-tv/components/ChannelGrid';

export default function LivePage() {
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  const categoriesQuery = useCategories();
  const channelsQuery = useChannels({
    category,
    q: deferredQuery || undefined,
    limit: 48,
  });

  return (
    <>
      <h1 className="pageTitle">Live TV</h1>
      <div style={{ maxWidth: 420, marginBottom: 'var(--mbolo-space-5)' }}>
        <Input
          type="search"
          placeholder="Rechercher une chaîne…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <CategoryTabs
        categories={categoriesQuery.data ?? []}
        active={category}
        onSelect={setCategory}
        isLoading={categoriesQuery.isLoading}
      />

      {channelsQuery.isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--mbolo-space-8)' }}>
          <Spinner />
        </div>
      ) : (
        <ChannelGrid channels={channelsQuery.data?.items ?? []} />
      )}
    </>
  );
}
