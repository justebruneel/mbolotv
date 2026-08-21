'use client';

import type { Overview } from '@mbolo/contracts';
import { useEffect, useState } from 'react';
import { ownerApi } from '../../../../features/owner/api/owner-api';

export default function ControlOverviewPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { ownerApi.overview().then(setOverview).catch((reason) => setError(reason instanceof Error ? reason.message : 'Connexion propriétaire requise.')); }, []);
  if (error) return <main className="p-6"><div className="card p-6 text-sm text-danger">{error}. <a className="font-semibold text-accent hover:underline" href="/owner/login">Se connecter</a></div></main>;
  if (!overview) return <main className="p-6 text-sm text-muted">Chargement de la console…</main>;
  return (
    <main className="space-y-6 p-6">
      <header><p className="text-xs font-semibold uppercase tracking-widest text-accent">Mbolo TV Control</p><h1 className="mt-2 text-2xl font-bold">Vue d’ensemble</h1><p className="mt-1 text-sm text-muted">Pilotez ce qui est visible et monétisable côté public.</p></header>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[['Sources', Object.values(overview.sourcesByStatus).reduce((sum, value) => sum + value, 0)], ['Chaînes', overview.channelCount], ['Variantes', overview.variantCount], ['Imports actifs', overview.activeImports]].map(([label, value]) => <div key={String(label)} className="card p-5"><p className="text-sm text-muted">{label}</p><p className="mt-2 text-3xl font-bold">{value}</p></div>)}
      </div>
      <div className="card p-5"><h2 className="font-semibold">Alertes</h2>{overview.alerts.length ? <div className="mt-3 space-y-2">{overview.alerts.map((alert) => <p key={alert.message} className="text-sm text-muted">{alert.severity === 'critical' ? '🔴' : '🟠'} {alert.message}</p>)}</div> : <p className="mt-3 text-sm text-success">Tout est propre.</p>}</div>
    </main>
  );
}
