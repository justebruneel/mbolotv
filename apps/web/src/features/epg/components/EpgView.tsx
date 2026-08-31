'use client';

import type { EpgRangeResponse, Programme } from '@mbolo/contracts';
import { EmptyState, EpgGrid, Skeleton } from '@mbolo/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buildWatchHref } from '../../live-tv/utils';
import { EpgDayList } from './EpgDayList';
import { ProgrammeDetail, type SelectedProgramme } from './ProgrammeDetail';

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
  const [selected, setSelected] = useState<SelectedProgramme | null>(null);

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

  const openProgramme = (channelName: string, programme: Programme): void => setSelected({ programme, channelName });

  return (
    <>
      {/* Mobile / tablette basse : guide en colonne, plus lisible qu'un
          défilement horizontal de 24 heures. */}
      <div className="md:hidden">
        <EpgDayList entries={data.items} category={category} onSelectProgramme={openProgramme} />
      </div>

      {/* Desktop : timeline horizontale, auto-centrée sur « maintenant ». */}
      <div className="hidden md:block">
        <EpgGrid
          entries={data.items}
          from={from}
          to={to}
          onSelectChannel={(channelId) => router.push(buildWatchHref(channelId, { category }))}
          onSelectProgramme={(programme) => {
            const entry = data.items.find((item) => item.channel.id === programme.channelId);
            openProgramme(entry?.channel.name ?? '', programme);
          }}
        />
      </div>

      {selected && <ProgrammeDetail selected={selected} category={category} onClose={() => setSelected(null)} />}
    </>
  );
}
