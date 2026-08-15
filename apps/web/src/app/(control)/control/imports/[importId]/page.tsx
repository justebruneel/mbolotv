import type { ImportRun } from '@mbolo/contracts';
import { notFound } from 'next/navigation';
import { serverOwnerFetch } from '../../../../../features/auth/server/owner-session';
import { Card, CardBody, CardHeader } from '../../../../../features/owner/components/ui/card';
import { formatDateTime, formatDuration } from '../../../../../features/owner/components/ui/format';
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconImports,
  IconLayers,
  IconRefresh,
  IconServer,
  IconTv,
  IconX,
} from '../../../../../features/owner/components/ui/icons';
import { BackLink, PageHeader } from '../../../../../features/owner/components/ui/page-header';
import { ImportStateBadge } from '../../../../../features/owner/components/ui/status-badge';

const METRICS: { key: string; label: string; icon: typeof IconTv; tone: string }[] = [
  { key: 'read', label: 'Lignes lues', icon: IconLayers, tone: 'text-muted' },
  { key: 'created', label: 'Chaînes créées', icon: IconTv, tone: 'text-success' },
  { key: 'updated', label: 'Chaînes mises à jour', icon: IconRefresh, tone: 'text-accent' },
  { key: 'duplicates', label: 'Doublons', icon: IconServer, tone: 'text-warning' },
  { key: 'ignored', label: 'Ignorées', icon: IconCheck, tone: 'text-muted' },
  { key: 'errors', label: 'Erreurs', icon: IconX, tone: 'text-danger' },
];

export default async function ImportDetailPage({
  params,
}: {
  params: Promise<{ importId: string }>;
}) {
  const { importId } = await params;
  const run = await serverOwnerFetch<ImportRun>(`/api/owner/imports/${importId}`).catch(() => null);
  if (!run) notFound();

  return (
    <>
      <BackLink href="/control/imports" label="Retour aux imports" />
      <PageHeader
        title={`Import #${run.id.slice(0, 8)}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <ImportStateBadge state={run.state} />
            <span className="text-muted">Source : {run.sourceName}</span>
          </span>
        }
      />

      {run.errorMessage && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {run.errorCode && <span className="mr-1 font-mono text-xs">[{run.errorCode}]</span>}
            {run.errorMessage}
          </span>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3">
        {METRICS.map((metric) => {
          const value = run.metrics?.[metric.key] ?? 0;
          const Icon = metric.icon;
          return (
            <div key={metric.key} className="card card-interactive p-4">
              <div className="flex items-center justify-between gap-3">
                <Icon className={`h-4 w-4 ${metric.tone}`} />
                <span className={`font-mono text-xl font-semibold tabular-nums ${metric.tone}`}>
                  {value}
                </span>
              </div>
              <p className="mt-2 text-sm text-muted">{metric.label}</p>
            </div>
          );
        })}
      </div>

      <Card>
        <CardHeader icon={<IconClock className="h-4 w-4" />} title="Chronologie" />
        <CardBody className="p-0">
          <dl className="divide-y divide-border">
            <div className="flex items-center justify-between gap-4 px-5 py-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Début</dt>
              <dd className="text-sm">{formatDateTime(run.startedAt)}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-5 py-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Fin</dt>
              <dd className="text-sm">{run.completedAt ? formatDateTime(run.completedAt) : 'En cours…'}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-5 py-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Durée</dt>
              <dd className="font-mono text-sm">{formatDuration(run.startedAt, run.completedAt)}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-5 py-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">État</dt>
              <dd className="flex items-center gap-2">
                <ImportStateBadge state={run.state} />
                <IconImports className="h-3.5 w-3.5 text-muted" />
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>
    </>
  );
}
