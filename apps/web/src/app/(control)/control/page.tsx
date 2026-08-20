import type { Overview } from '@mbolo/contracts';
import { Card, CardBody, CardHeader } from '../../../features/owner/components/ui/card';
import { formatRelative } from '../../../features/owner/components/ui/format';
import {
  IconActivity,
  IconAlert,
  IconAudit,
  IconChevronRight,
  IconImports,
  IconLayers,
  IconTv,
} from '../../../features/owner/components/ui/icons';
import { PageHeader } from '../../../features/owner/components/ui/page-header';
import { StatCard } from '../../../features/owner/components/ui/stat-card';
import { serverOwnerFetch } from '../../../features/auth/server/owner-session';

const STATUS_SEGMENTS: { key: string; label: string; bar: string; text: string }[] = [
  { key: 'READY', label: 'Prêtes', bar: 'bg-success', text: 'text-success' },
  { key: 'IMPORTING', label: 'En import', bar: 'bg-accent', text: 'text-accent' },
  { key: 'DEGRADED', label: 'Dégradées', bar: 'bg-warning', text: 'text-warning' },
  { key: 'FAILED', label: 'En erreur', bar: 'bg-danger', text: 'text-danger' },
  { key: 'PENDING', label: 'En attente', bar: 'bg-border', text: 'text-muted' },
  { key: 'DISABLED', label: 'Désactivées', bar: 'bg-border', text: 'text-muted' },
];

function SourceStatusCard({ sourcesByStatus }: { sourcesByStatus: Record<string, number> }) {
  const total = Object.values(sourcesByStatus).reduce((sum, value) => sum + (value ?? 0), 0);

  return (
    <Card className="overflow-hidden animate-slide-up stagger-5">
      <CardHeader
        icon={<IconActivity className="h-4 w-4" />}
        title="Sources par statut"
        description={`${total} source(s) au total`}
      />
      <CardBody>
        {total === 0 ? (
          <p className="py-6 text-center text-sm text-muted">
            Aucune source configurée pour le moment.
          </p>
        ) : (
          <>
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-2">
              {STATUS_SEGMENTS.map((segment) => {
                const count = sourcesByStatus[segment.key] ?? 0;
                if (count === 0) return null;
                return (
                  <div
                    key={segment.key}
                    className={`${segment.bar} h-full transition-all duration-500`}
                    style={{ width: `${(count / total) * 100}%` }}
                    title={`${segment.label} : ${count}`}
                  />
                );
              })}
            </div>
            <ul className="mt-5 flex flex-wrap gap-x-6 gap-y-3">
              {STATUS_SEGMENTS.map((segment) => {
                const count = sourcesByStatus[segment.key] ?? 0;
                return (
                  <li key={segment.key} className="flex items-center gap-2 text-sm">
                    <span className={`h-2.5 w-2.5 rounded-full ${segment.bar}`} aria-hidden />
                    <span className="text-secondary">{segment.label}</span>
                    <span className={`font-mono font-bold tabular-nums ${segment.text}`}>
                      {count}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function RecentActivity({ items }: { items: Overview['recentAudit'] }) {
  if (items.length === 0) {
    return (
      <Card className="animate-slide-up stagger-6">
        <CardHeader icon={<IconAudit className="h-4 w-4" />} title="Activité récente" />
        <CardBody>
          <p className="py-6 text-center text-sm text-muted">Aucune activité récente.</p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card className="animate-slide-up stagger-6">
      <CardHeader
        icon={<IconAudit className="h-4 w-4" />}
        title="Activité récente"
        description="Derniers événements de la console"
        actions={
          <a
            href="/control/audit"
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-accent transition-colors hover:bg-accent-muted"
          >
            Tout l'audit <IconChevronRight className="h-3 w-3" />
          </a>
        }
      />
      <ul className="divide-y divide-border">
        {items.map((entry) => (
          <li key={entry.id} className="flex items-center gap-3 px-6 py-3.5 transition-colors hover:bg-surface-2/50">
            <span className="shrink-0 rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-muted">
              {entry.action}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-secondary">
              {entry.entity}
              {entry.entityId ? (
                <span className="ml-1 font-mono text-xs text-faint">
                  · {entry.entityId.slice(0, 8)}
                </span>
              ) : null}
            </span>
            <time className="shrink-0 text-xs text-faint">
              {formatRelative(entry.createdAt)}
            </time>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default async function OverviewPage() {
  let overview: Overview;
  try {
    overview = await serverOwnerFetch<Overview>('/api/owner/overview');
  } catch {
    return (
      <div className="rounded-2xl border border-danger/30 bg-danger-muted px-5 py-4 text-sm text-danger animate-fade-in">
        Impossible de charger la vue d'ensemble.
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Vue d'ensemble"
        description="État de la plateforme et activité de la console propriétaire."
      />

      {overview.alerts.length > 0 && (
        <div className="mb-6 flex flex-col gap-2">
          {overview.alerts.map((alert, index) => (
            <div
              key={index}
              className={`flex items-start gap-3 rounded-xl border px-5 py-4 text-sm font-medium ${
                alert.severity === 'critical'
                  ? 'border-danger/40 bg-danger-muted text-danger'
                  : 'border-warning/40 bg-warning-muted text-warning'
              }`}
            >
              <IconAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="flex-1">{alert.message}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={<IconTv className="h-5 w-5" />} label="Chaînes" value={overview.channelCount} tone="accent" />
        <StatCard icon={<IconLayers className="h-5 w-5" />} label="Variantes de flux" value={overview.variantCount} tone="default" />
        <StatCard icon={<IconImports className="h-5 w-5" />} label="Imports actifs" value={overview.activeImports} tone="warning" sub={overview.activeImports > 0 ? 'Traitement en cours' : undefined} />
        <StatCard icon={<IconActivity className="h-5 w-5" />} label="Matchs en direct" value={overview.liveMatches} tone="success" />
      </div>

      <div className="mb-8">
        <SourceStatusCard sourcesByStatus={overview.sourcesByStatus} />
      </div>

      <RecentActivity items={overview.recentAudit} />
    </div>
  );
}
