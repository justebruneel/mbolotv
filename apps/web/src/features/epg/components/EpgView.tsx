'use client';

import type { EpgRangeResponse } from '@mbolo/contracts';
import { EmptyState, EpgGrid, Skeleton } from '@mbolo/ui';
import { useRouter } from 'next/navigation';
import { buildWatchHref } from '../../live-tv/utils';

export function EpgView({
  data,
  isLoading,
  from,
  to,
  category,
}: {
  data?: EpgRangeResponse;
  isLoading: boolean;
  from: Date;
  to: Date;
  category?: string;
}) {
  const router = useRouter();

  if (isLoading || !data) {
    return (
      <div className="flex flex-col gap-3">
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
      onSelectChannel={(channelId) => router.push(buildWatchHref(channelId, { category }))}
    />
  );
}
