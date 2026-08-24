'use client';

import type { ImportRun } from '@mbolo/contracts';
import { useEffect, useState } from 'react';
import { ownerApi } from '../api/owner-api';
import { Card, CardBody } from './ui/card';
import { IconLayers, IconRefresh, IconServer, IconTv, IconX } from './ui/icons';
import { ImportStateBadge } from './ui/status-badge';

const METRICS: { key: string; label: string; icon: typeof IconTv; tone: string }[] = [
  { key: 'read', label: 'Chaînes lues', icon: IconLayers, tone: 'text-muted' },
  { key: 'created', label: 'Éléments créés', icon: IconTv, tone: 'text-success' },
  { key: 'updated', label: 'Éléments mis à jour', icon: IconRefresh, tone: 'text-accent' },
  { key: 'duplicates', label: 'Doublons', icon: IconServer, tone: 'text-warning' },
  { key: 'errors', label: 'Erreurs', icon: IconX, tone: 'text-danger' },
];
const ACTIVE = new Set(['QUEUED', 'FETCHING', 'PARSING', 'NORMALIZING']);

export function ImportLiveStatus({ initialRun }: { initialRun: ImportRun }) {
  const [run, setRun] = useState(initialRun);
  const [canceling, setCanceling] = useState(false);
  const active = ACTIVE.has(run.state);
  const processed = run.metrics?.processed ?? run.metrics?.read ?? 0;

  useEffect(() => {
    if (!ACTIVE.has(run.state)) return;
    const timer = window.setInterval(() => {
      ownerApi.imports.detail(initialRun.id).then(setRun).catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [initialRun.id, run.state]);

  async function cancel() {
    setCanceling(true);
    try { setRun(await ownerApi.imports.cancel(run.id)); } finally { setCanceling(false); }
  }

  const total = run.metrics?.read ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const indeterminate = active && total === 0;

  return (
    <>
      {active && (
        <Card className="mb-6 border-accent/30">
          <CardBody>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2"><ImportStateBadge state={run.state} /><span className="text-sm text-muted">{processed}{total ? ` / ${total}` : ''} chaîne(s) traitée(s){pct ? ` · ${pct}%` : ''}</span></div>
                <p className="mt-2 text-xs text-muted">La progression se met à jour automatiquement.</p>
              </div>
              <button type="button" className="btn btn-secondary" onClick={cancel} disabled={canceling}>
                {canceling ? 'Annulation…' : 'Annuler l’import'}
              </button>
            </div>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-surface-2">
              <div
                className={`h-full rounded-full bg-accent/70 transition-all duration-500 ${indeterminate ? 'w-full animate-pulse' : ''}`}
                style={indeterminate ? undefined : { width: `${pct || 4}%` }}
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
          </CardBody>
        </Card>
      )}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3">
        {METRICS.map((metric) => { const value = run.metrics?.[metric.key] ?? 0; const Icon = metric.icon; return <div key={metric.key} className="card card-interactive p-4"><div className="flex items-center justify-between gap-3"><Icon className={`h-4 w-4 ${metric.tone}`} /><span className={`font-mono text-xl font-semibold tabular-nums ${metric.tone}`}>{value}</span></div><p className="mt-2 text-sm text-muted">{metric.label}</p></div>; })}
      </div>
    </>
  );
}
