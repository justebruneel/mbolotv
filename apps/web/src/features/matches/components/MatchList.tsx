'use client';

import type { Match, MatchListResponse, MatchQuery, MatchState } from '@mbolo/contracts';
import { EmptyState, MatchCard, Skeleton } from '@mbolo/ui';

const STATE_OPTIONS: Array<{ value?: MatchState; label: string }> = [
  { label: 'Tous' },
  { value: 'LIVE', label: 'En direct' },
  { value: 'SCHEDULED', label: 'À venir' },
  { value: 'FINISHED', label: 'Terminés' },
];

export function MatchFilters({
  sport,
  state,
  onChange,
}: {
  sport: string;
  state?: MatchState;
  onChange: (params: Partial<MatchQuery>) => void;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-sm text-muted">
        Sport
        <select
          value={sport}
          onChange={(event) => onChange({ sport: event.target.value || undefined })}
          className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent"
        >
          <option value="">Tous les sports</option>
          <option value="Football">Football</option>
          <option value="Basketball">Basketball</option>
          <option value="Tennis">Tennis</option>
          <option value="Rugby">Rugby</option>
          <option value="Cyclisme">Cyclisme</option>
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        {STATE_OPTIONS.map((option) => (
          <button
            key={option.label}
            type="button"
            onClick={() => onChange({ state: option.value })}
            className={
              state === option.value
                ? 'rounded-full border border-primary bg-primary px-3.5 py-2 text-sm font-semibold text-on-primary'
                : 'rounded-full border border-border bg-surface px-3.5 py-2 text-sm font-semibold text-muted transition-colors hover:border-accent/60 hover:text-foreground'
            }
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function MatchList({ data, isLoading }: { data?: MatchListResponse; isLoading: boolean }) {
  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} height={140} />
        ))}
      </div>
    );
  }

  if (data.items.length === 0) {
    return <EmptyState title="Aucun match" hint="Aucune rencontre ne correspond à ces filtres." />;
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
      {data.items.map((match: Match) => (
        <MatchCard key={match.id} match={match} />
      ))}
    </div>
  );
}
