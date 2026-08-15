import type { AuditEntry } from '@mbolo/contracts';
import { EmptyState } from '@mbolo/ui';
import { serverOwnerFetch } from '../../../../features/auth/server/owner-session';
import { Card, CardBody } from '../../../../features/owner/components/ui/card';
import { formatDateTime } from '../../../../features/owner/components/ui/format';
import { IconSearch } from '../../../../features/owner/components/ui/icons';
import { PageHeader } from '../../../../features/owner/components/ui/page-header';

const ACTION_TONE: Record<string, string> = {
  SOURCE_CREATED: 'text-success',
  SOURCE_UPDATED: 'text-accent',
  SOURCE_DELETED: 'text-danger',
  IMPORT_STARTED: 'text-accent',
  IMPORT_COMPLETED: 'text-success',
  IMPORT_FAILED: 'text-danger',
};

function details(entry: AuditEntry): string {
  if (!entry.metadata) return '—';
  const parts = Object.entries(entry.metadata)
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .slice(0, 3);
  return parts.length ? parts.join(' · ') : '—';
}

export default async function AuditPage() {
  const result = await serverOwnerFetch<{ items: AuditEntry[]; total: number }>(
    '/api/owner/audit?limit=200',
  ).catch(() => null);

  return (
    <>
      <PageHeader
        title="Journal d’audit"
        description={result ? `${result.total} entrée(s) — ${result.items.length} affichée(s) sur les plus récentes.` : undefined}
      />

      {!result ? (
        <p className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          Impossible de charger l’audit.
        </p>
      ) : result.items.length === 0 ? (
        <div className="card">
          <EmptyState title="Aucune entrée" hint="Les actions de la console apparaîtront ici." />
        </div>
      ) : (
        <Card className="overflow-hidden">
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full min-w-[720px] text-left">
              <thead>
                <tr className="border-b border-border bg-surface-2/60">
                  <th className="th">Date</th>
                  <th className="th">Action</th>
                  <th className="th">Entité</th>
                  <th className="th">Détails</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.items.map((entry) => (
                  <tr key={entry.id} className="transition-colors hover:bg-surface-2/40">
                    <td className="td whitespace-nowrap text-xs text-muted">
                      {formatDateTime(entry.createdAt)}
                    </td>
                    <td className={`td whitespace-nowrap font-mono text-xs font-semibold ${ACTION_TONE[entry.action] ?? 'text-muted'}`}>
                      {entry.action}
                    </td>
                    <td className="td text-muted">
                      {entry.entity}
                      {entry.entityId ? (
                        <span className="font-mono text-xs"> · {entry.entityId.slice(0, 8)}</span>
                      ) : null}
                    </td>
                    <td className="td max-w-md truncate text-xs text-muted">
                      <span className="flex items-center gap-1.5">
                        <IconSearch className="h-3.5 w-3.5 shrink-0" />
                        {details(entry)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}
    </>
  );
}
