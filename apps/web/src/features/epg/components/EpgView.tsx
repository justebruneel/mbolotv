'use client';

import type { EpgRangeResponse } from '@mbolo/contracts';
import { EmptyState, EpgGrid, Skeleton } from '@mbolo/ui';
import { useRouter } from 'next/navigation';

export function EpgView({
  data,
  isLoading,
  from,
  to,
}: {
  data?: EpgRangeResponse;
  isLoading: boolean;
  from: Date;
  to: Date;
}) {
  const router = useRouter();

  if (isLoading || !data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mbolo-space-3)' }}>
        {Array.from({ length: 10 }).map((_, index) => (
          <Skeleton key={index} height={56} />
        ))}
      </div>
    );
  }

  if (data.items.length === 0) {
    return <EmptyState title="Aucune programmation sur cette plage" hint="Revenez plus tard ou changez de catégorie." />;
  }

  return (
    <EpgGrid
      entries={data.items}
      from={from}
      to={to}
      onSelectChannel={(channelId) => router.push(`/watch/${channelId}`)}
    />
  );
}
