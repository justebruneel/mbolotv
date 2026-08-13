'use client';

import { useMemo, useState } from 'react';
import { useCategories, useEpgRange } from '../../../shared/api/queries';
import { CategoryTabs } from '../../../features/live-tv/components/CategoryTabs';
import { EpgView } from '../../../features/epg/components/EpgView';

export default function EpgPage() {
  const [category, setCategory] = useState<string | undefined>(undefined);
  const categoriesQuery = useCategories();

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
      <h1 className="pageTitle">Guide TV</h1>
      <p className="muted" style={{ marginTop: -16 }}>
        Programmation des prochaines heures
      </p>

      <div style={{ marginTop: 'var(--mbolo-space-5)' }}>
        <CategoryTabs
          categories={categoriesQuery.data ?? []}
          active={category}
          onSelect={setCategory}
          isLoading={categoriesQuery.isLoading}
        />
      </div>

      <EpgView data={epgQuery.data} isLoading={epgQuery.isLoading} from={window.from} to={window.to} />
    </>
  );
}
