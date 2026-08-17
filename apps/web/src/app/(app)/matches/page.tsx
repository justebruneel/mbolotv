'use client';

import { useState } from 'react';
import type { MatchQuery, MatchState } from '@mbolo/contracts';
import { useMatches } from '../../../shared/api/queries';
import { MatchFilters, MatchList } from '../../../features/matches/components/MatchList';
import { PageHeader } from '../../../shared/components/PageHeader';

export default function MatchesPage() {
  const [filters, setFilters] = useState<MatchQuery>({});

  const polling = !filters.state || filters.state === 'LIVE';
  const matchesQuery = useMatches(filters, polling ? 60_000 : 0);

  return (
    <>
      <PageHeader title="Matches" description="Les rencontres à suivre en direct et à venir." />
      <MatchFilters
        sport={filters.sport ?? ''}
        state={filters.state as MatchState | undefined}
        onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
      />
      <MatchList data={matchesQuery.data} isLoading={matchesQuery.isLoading} />
    </>
  );
}
