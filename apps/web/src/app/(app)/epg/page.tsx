'use client';

import { Icon } from '@mbolo/ui';
import { useMemo, useState } from 'react';
import { useCategories, useEpgRange } from '../../../shared/api/queries';
import { EpgView } from '../../../features/epg/components/EpgView';
import { ProgrammeSearch } from '../../../features/epg/components/ProgrammeSearch';
import { formatCategoryName } from '../../../features/live-tv/utils';

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

const PILL = 'shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-bold transition';
const PILL_ON = 'border-accent bg-accent text-on-accent';
const PILL_OFF = 'border-border bg-surface text-muted hover:bg-surface-2 hover:text-foreground';

export default function EpgPage() {
  const [offset, setOffset] = useState(0); // -1 hier, 0 aujourd'hui, 1 demain
  const [category, setCategory] = useState<string | undefined>(undefined);
  const base = useMemo(() => addDays(startOfDay(new Date()), offset), [offset]);
  const from = useMemo(() => {
    const f = new Date(base);
    f.setHours(6, 0, 0, 0);
    return f;
  }, [base]);
  const to = useMemo(() => {
    const t = new Date(base);
    t.setHours(30, 0, 0, 0); // 06h lendemain (24+6)
    return t;
  }, [base]);

  const categoriesQuery = useCategories();
  const topCategories = useMemo(
    () => [...(categoriesQuery.data ?? [])].sort((a, b) => (b.channelCount ?? 0) - (a.channelCount ?? 0)).slice(0, 12),
    [categoriesQuery.data],
  );
  const epgQuery = useEpgRange(from, to, category);

  const label = offset === -1 ? 'Hier' : offset === 0 ? "Aujourd'hui" : offset === 1 ? 'Demain' : base.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <main className="mx-auto max-w-[1600px] px-4 py-6 md:px-10">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-widest text-accent">Programmes TV</p>
        <h1 className="mt-1 text-2xl font-black tracking-tight">Grille des programmes</h1>
        <p className="mt-1 text-sm text-muted">EPG enrichi TVmaze — affiches et synopsis quand disponibles.</p>
      </header>

      <div className="mb-6">
        <ProgrammeSearch />
      </div>

      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setOffset((v) => v - 1)} aria-label="Jour précédent" className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface hover:bg-surface-2">
            <Icon.ChevronLeft size={16} aria-hidden />
          </button>
          <span className="min-w-[140px] text-center text-sm font-bold capitalize">{label}</span>
          <button type="button" onClick={() => setOffset((v) => v + 1)} aria-label="Jour suivant" className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface hover:bg-surface-2">
            <Icon.ChevronRight size={16} aria-hidden />
          </button>
          {offset !== 0 && (
            <button type="button" onClick={() => setOffset(0)} className="ml-2 text-xs font-semibold text-accent hover:underline">
              Aujourd'hui
            </button>
          )}
        </div>
        <span className="hidden text-xs text-muted sm:inline">
          {from.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} – {to.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {/* Filtre par catégorie (l'API accepte déjà category côté /epg/range). */}
      {topCategories.length > 0 && (
        <div className="mb-5 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label="Filtrer par catégorie">
          <button type="button" aria-pressed={!category} onClick={() => setCategory(undefined)} className={`${PILL} ${!category ? PILL_ON : PILL_OFF}`}>
            Toutes
          </button>
          {topCategories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              aria-pressed={category === cat.slug}
              onClick={() => setCategory(category === cat.slug ? undefined : cat.slug)}
              className={`${PILL} ${category === cat.slug ? PILL_ON : PILL_OFF}`}
            >
              {formatCategoryName(cat.name)}
            </button>
          ))}
        </div>
      )}

      <EpgView data={epgQuery.data} isLoading={epgQuery.isLoading} from={from} to={to} category={category} />

      <p className="mt-6 text-center text-xs text-faint">
        Données séries : TVmaze — Données EPG via fournisseurs configurés (XMLTV.fr, Xtream, etc.)
      </p>
    </main>
  );
}
