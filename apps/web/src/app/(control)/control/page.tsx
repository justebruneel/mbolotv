import type { Overview } from '@mbolo/contracts';
import Link from 'next/link';
import { serverOwnerFetch } from '../../../features/auth/server/owner-session';

const STATUS_LABELS: Record<string, string> = {
  CONNECTED: 'Connectées',
  DEGRADED: 'Dégradées',
  FAILED: 'En erreur',
  PENDING: 'En attente',
};

export default async function OverviewPage() {
  let overview: Overview;
  try {
    overview = await serverOwnerFetch<Overview>('/api/owner/overview');
  } catch {
    return <p className="text-muted">Impossible de charger la vue d’ensemble.</p>;
  }

  return (
    <>
      <h1 className="pageTitle">Vue d’ensemble</h1>

      {overview.alerts.length > 0 && (
        <div className="mb-6 flex flex-col gap-2">
          {overview.alerts.map((alert, index) => (
            <p
              key={index}
              className={`rounded-lg border px-3 py-2 text-sm ${
                alert.severity === 'critical'
                  ? 'border-red-500/40 bg-red-500/10 text-red-300'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
              }`}
            >
              {alert.message}
            </p>
          ))}
        </div>
      )}

      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          { label: 'Chaînes', value: overview.channelCount },
          { label: 'Variantes de flux', value: overview.variantCount },
          { label: 'Imports actifs', value: overview.activeImports },
          { label: 'Matchs en direct', value: overview.liveMatches },
        ].map((stat) => (
          <div key={stat.label} className="rounded-xl border border-border bg-surface p-4">
            <p className="text-2xl font-bold">{stat.value}</p>
            <p className="text-sm text-muted">{stat.label}</p>
          </div>
        ))}
      </div>

      <h2 className="mb-3 font-semibold">Sources par statut</h2>
      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        {Object.entries(STATUS_LABELS).map(([status, label]) => (
          <div key={status} className="rounded-xl border border-border bg-surface p-4">
            <p className="text-2xl font-bold">{overview.sourcesByStatus[status] ?? 0}</p>
            <p className="text-sm text-muted">{label}</p>
          </div>
        ))}
      </div>

      <h2 className="mb-3 font-semibold">Activité récente</h2>
      <Link
        href="/control/audit"
        className="mb-3 inline-block text-sm text-accent hover:underline"
      >
        Voir tout l’audit →
      </Link>
      <ul className="flex flex-col gap-2">
        {overview.recentAudit.map((entry) => (
          <li key={entry.id} className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 text-sm">
            <span className="truncate">
              <span className="font-semibold">{entry.action}</span>
              <span className="text-muted"> · {entry.entity}</span>
            </span>
            <time dateTime={entry.createdAt} className="ml-4 shrink-0 text-xs text-muted">
              {new Date(entry.createdAt).toLocaleString('fr-FR')}
            </time>
          </li>
        ))}
      </ul>
    </>
  );
}