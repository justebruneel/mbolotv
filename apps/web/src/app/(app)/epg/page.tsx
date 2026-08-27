'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EpgView } from '../../../features/epg/components/EpgView';
import { ProgrammeSearch } from '../../../features/epg/components/ProgrammeSearch';
import { apiGet } from '../../../shared/api/client';
import type { EpgRangeResponse } from '@mbolo/contracts';
import { Icon } from '@mbolo/ui';

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

export default function EpgPage() {
  const [offset, setOffset] = useState(0); // -1 hier, 0 aujourd'hui, 1 demain
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

  const epgQuery = useQuery({
    queryKey: ['epg', from.toISOString(), to.toISOString()],
    queryFn: () => apiGet<EpgRangeResponse>('/epg/range', { from: from.toISOString(), to: to.toISOString() }),
    staleTime: 2 * 60_000,
  });

  const label = offset === -1 ? 'Hier' : offset === 0 ? "Aujourd'hui" : offset === 1 ? 'Demain' : base.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <main className="mx-auto max-w-[1600px] px-4 py-6 md:px-10">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-widest text-accent">Programmes TV</p>
        <h1 className="mt-1 text-2xl font-black tracking-tight">Grille des programmes</h1>
        <p className="mt-1 text-sm text-muted">EPG enrichi TMDB — affiches, synopsis et bandes-annonces quand disponibles.</p>
      </header>

      <div className="mb-6">
        <ProgrammeSearch />
      </div>

      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setOffset((v) => v - 1)} className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface hover:bg-surface-2">
            <Icon.ChevronLeft size={16} aria-hidden />
          </button>
          <span className="min-w-[140px] text-center text-sm font-bold capitalize">{label}</span>
          <button type="button" onClick={() => setOffset((v) => v + 1)} className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface hover:bg-surface-2">
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

      <EpgView data={epgQuery.data} isLoading={epgQuery.isLoading} from={from} to={to} />

      <p className="mt-6 text-center text-xs text-faint">
        This product uses the TMDB API but is not endorsed or certified by TMDB. — Données EPG via fournisseurs configurés (XMLTV.fr, Xtream, etc.)
      </p>
    </main>
  );
}
