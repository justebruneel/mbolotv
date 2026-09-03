'use client';

import type { ImportRun, Overview, SourceResponse } from '@mbolo/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ownerApi } from '../../../../features/owner/api/owner-api';

const ACTIVE = new Set(['QUEUED', 'FETCHING', 'PARSING', 'NORMALIZING']);
const STATE_LABEL: Record<string, string> = { QUEUED: 'En attente', FETCHING: 'Téléchargement', PARSING: 'Lecture', NORMALIZING: 'Enregistrement', COMPLETED: 'Terminé', FAILED: 'Échec', CANCELED: 'Annulé' };

export default function ControlOverviewPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [sources, setSources] = useState<SourceResponse[]>([]);
  const [imports, setImports] = useState<ImportRun[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextOverview, nextSources, nextImports] = await Promise.all([ownerApi.overview(), ownerApi.sources.list(), ownerApi.imports.list()]);
      setOverview(nextOverview); setSources(nextSources); setImports(nextImports.items); setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Connexion propriétaire requise.'); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 15_000); return () => window.clearInterval(timer); }, [refresh]);

  async function toggleSource(source: SourceResponse): Promise<void> {
    setBusy(source.id);
    try { await ownerApi.sources.update(source.id, { status: source.status === 'DISABLED' ? 'READY' : 'DISABLED' }); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Modification impossible.'); }
    finally { setBusy(null); }
  }
  async function startImport(source: SourceResponse): Promise<void> {
    setBusy(`import:${source.id}`);
    try { await ownerApi.sources.import(source.id); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Import impossible.'); }
    finally { setBusy(null); }
  }

  const activeImports = useMemo(() => imports.filter((run) => ACTIVE.has(run.state)), [imports]);
  const recentImports = imports.slice(0, 8);
  if (error && !overview) return <main className="p-6"><div className="card p-6 text-sm text-danger">{error}. <a className="font-semibold text-accent hover:underline" href="/owner/login">Se connecter</a></div></main>;
  if (!overview) return <main className="p-6 text-sm text-muted">Chargement de la console…</main>;

  return (
    <main className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-widest text-accent">Mbolo TV Control</p><h1 className="mt-2 text-2xl font-bold">Centre d’opérations</h1><p className="mt-1 text-sm text-muted">Sources, imports, publication et incidents au même endroit.</p></div><button className="btn" onClick={() => void refresh()}>Actualiser</button></header>
      {error && <p className="card border-danger/30 bg-danger-muted p-3 text-sm text-danger">{error}</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {[['Sources', sources.length], ['Chaînes', overview.channelCount], ['Flux actifs', overview.variantCount], ['Imports actifs', activeImports.length], ['Sources en échec', overview.sourcesByStatus.FAILED ?? 0]].map(([label, value]) => <div key={String(label)} className="card p-5"><p className="text-sm text-muted">{label}</p><p className="mt-2 text-3xl font-bold">{value}</p></div>)}
      </div>
      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <section className="card overflow-hidden"><div className="flex items-center justify-between border-b border-border p-5"><div><h2 className="font-semibold">Sources</h2><p className="text-xs text-muted">Activez, coupez ou relancez sans changer de page.</p></div><Link className="text-sm font-semibold text-accent hover:underline" href="/control/sources">Tout gérer</Link></div><div className="divide-y divide-border/70">{sources.map((source) => { const running = activeImports.some((run) => run.sourceId === source.id); return <div key={source.id} className="flex flex-wrap items-center gap-3 p-4"><div className="min-w-[180px] flex-1"><p className="font-medium">{source.name}</p><p className="text-xs text-muted">{source.kind} · {source.status}{source.lastSyncedAt ? ` · sync ${new Date(source.lastSyncedAt).toLocaleString('fr-FR')}` : ''}</p></div><span className={`rounded-full px-2 py-1 text-xs font-semibold ${source.status === 'FAILED' ? 'bg-danger/10 text-danger' : source.status === 'DISABLED' ? 'bg-surface-2 text-muted' : 'bg-success/10 text-success'}`}>{running ? 'Import en cours' : source.status}</span><button className="btn" disabled={busy !== null || running || source.status === 'DISABLED'} onClick={() => void startImport(source)}>Importer</button><button className={`btn ${source.status === 'DISABLED' ? 'btn-primary' : 'btn-danger'}`} disabled={busy !== null || running} onClick={() => void toggleSource(source)}>{source.status === 'DISABLED' ? 'Activer' : 'Désactiver'}</button></div>; })}{sources.length === 0 && <p className="p-5 text-sm text-muted">Aucune source configurée.</p>}</div></section>
        <section className="card overflow-hidden"><div className="flex items-center justify-between border-b border-border p-5"><div><h2 className="font-semibold">Imports récents</h2><p className="text-xs text-muted">Mise à jour automatique toutes les 15 s.</p></div><Link className="text-sm font-semibold text-accent hover:underline" href="/control/imports">Historique</Link></div><div className="divide-y divide-border/70">{recentImports.map((run) => { const metrics = run.metrics ?? {}; const processed = Number(metrics.processed ?? 0); const read = Number(metrics.read ?? 0); const percent = read > 0 ? Math.min(100, Math.round(processed / read * 100)) : 0; return <div key={run.id} className="p-4"><div className="flex items-center justify-between gap-3"><div><p className="text-sm font-medium">{run.sourceName}</p><p className={`text-xs ${run.state === 'FAILED' ? 'text-danger' : 'text-muted'}`}>{STATE_LABEL[run.state] ?? run.state}{run.errorMessage ? ` · ${run.errorMessage}` : ''}</p></div><span className="text-xs font-semibold">{ACTIVE.has(run.state) ? `${percent}%` : processed.toLocaleString('fr-FR')}</span></div>{ACTIVE.has(run.state) && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.max(4, percent)}%` }} /></div>}</div>; })}{recentImports.length === 0 && <p className="p-5 text-sm text-muted">Aucun import.</p>}</div></section>
      </div>
      <section className="card p-5"><h2 className="font-semibold">Alertes</h2>{overview.alerts.length ? <div className="mt-3 space-y-2">{overview.alerts.map((alert) => <p key={alert.message} className="text-sm text-muted">{alert.severity === 'critical' ? '🔴' : '🟠'} {alert.message}</p>)}</div> : <p className="mt-3 text-sm text-success">Aucune alerte critique.</p>}</section>
    </main>
  );
}
