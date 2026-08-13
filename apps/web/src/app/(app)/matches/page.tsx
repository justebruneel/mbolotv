'use client';

import { useState } from 'react';
import type { MatchQuery, MatchState } from '@mbolo/contracts';
import { useMatches } from '../../../shared/api/queries';
import { MatchFilters, MatchList } from '../../../features/matches/components/MatchList';

export default function MatchesPage() {
  const [filters, setFilters] = useState<MatchQuery>({});

  const matchesQuery = useMatches(filters);

  return (
    <>
      <h1 className="pageTitle">Matches</h1>
      <MatchFilters
        sport={filters.sport ?? ''}
        state={filters.state as MatchState | undefined}
        onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
      />
      <MatchList data={matchesQuery.data} isLoading={matchesQuery.isLoading} />
    </>
  );
}
