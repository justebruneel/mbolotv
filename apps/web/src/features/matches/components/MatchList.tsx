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
    <div style={{ display: 'flex', gap: 'var(--mbolo-space-3)', flexWrap: 'wrap', marginBottom: 'var(--mbolo-space-5)' }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--mbolo-font-size-sm)', color: 'var(--mbolo-text-muted)' }}>
        Sport
        <select
          value={sport}
          onChange={(event) => onChange({ sport: event.target.value || undefined })}
          style={{ background: 'var(--mbolo-surface-2)', color: 'var(--mbolo-text)', border: '1px solid var(--mbolo-border)', borderRadius: 'var(--mbolo-radius)', padding: '8px 12px', font: 'inherit' }}
        >
          <option value="">Tous les sports</option>
          <option value="Football">Football</option>
          <option value="Basketball">Basketball</option>
          <option value="Tennis">Tennis</option>
          <option value="Rugby">Rugby</option>
          <option value="Cyclisme">Cyclisme</option>
        </select>
      </label>
      <div style={{ display: 'flex', gap: 'var(--mbolo-space-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        {STATE_OPTIONS.map((option) => (
          <button
            key={option.label}
            type="button"
            onClick={() => onChange({ state: option.value })}
            style={{
              border: `1px solid ${state === option.value ? 'var(--mbolo-primary)' : 'var(--mbolo-border)'}`,
              background: state === option.value ? 'var(--mbolo-primary)' : 'var(--mbolo-surface)',
              color: state === option.value ? '#fff' : 'var(--mbolo-text-muted)',
              borderRadius: 999,
              padding: '8px 14px',
              font: 'inherit',
              fontSize: 'var(--mbolo-font-size-sm)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 'var(--mbolo-space-4)' }}>
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
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 'var(--mbolo-space-4)' }}>
      {data.items.map((match: Match) => (
        <MatchCard key={match.id} match={match} />
      ))}
    </div>
  );
}
