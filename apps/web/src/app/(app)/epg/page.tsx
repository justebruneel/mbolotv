'use client';

import { useMemo, useState } from 'react';
import { useCategories, useEpgRange } from '../../../shared/api/queries';
import { CategoryTabs } from '../../../features/live-tv/components/CategoryTabs';
import { EpgView } from '../../../features/epg/components/EpgView';
import { ProgrammeSearch } from '../../../features/epg/components/ProgrammeSearch';
import { useReminderScheduler } from '../../../features/epg/hooks/useReminderScheduler';
import { PageHeader } from '../../../shared/components/PageHeader';

export default function EpgPage() {
  const [category, setCategory] = useState<string | undefined>(undefined);
  const categoriesQuery = useCategories();
  useReminderScheduler();

  const window = useMemo(() => {
    const now = Date.now();
    const from = new Date(now - 60 * 60_000);
    const to = new Date(now + 6 * 3_600_000);
    return { from, to };
  }, []);

  const epgQuery = useEpgRange({
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    category,
  });

  return (
    <>
      <PageHeader
        title="Guide TV"
        description="Programmation des prochaines heures"
      />

      <div className="mb-5">
        <ProgrammeSearch />
      </div>

      <div className="mb-5">
        <CategoryTabs
          categories={categoriesQuery.data ?? []}
          active={category}
          onSelect={setCategory}
          isLoading={categoriesQuery.isLoading}
        />
      </div>

      <EpgView data={epgQuery.data} isLoading={epgQuery.isLoading} from={window.from} to={window.to} category={category} />
    </>
  );
}
