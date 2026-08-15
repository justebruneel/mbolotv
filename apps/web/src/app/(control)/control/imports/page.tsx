import type { ImportRunListResponse } from '@mbolo/contracts';
import { EmptyState } from '@mbolo/ui';
import Link from 'next/link';
import { serverOwnerFetch } from '../../../../features/auth/server/owner-session';
import { Card, CardBody } from '../../../../features/owner/components/ui/card';
import { formatDateTime } from '../../../../features/owner/components/ui/format';
import {
  IconChevronRight,
  IconClock,
  IconImports,
} from '../../../../features/owner/components/ui/icons';
import { PageHeader } from '../../../../features/owner/components/ui/page-header';
import { ImportStateBadge } from '../../../../features/owner/components/ui/status-badge';

export default async function ImportsPage() {
  const imports = await serverOwnerFetch<ImportRunListResponse>('/api/owner/imports').catch(
    () => null,
  );

  return (
    <>
      <PageHeader
        title="Imports"
        description={imports ? `Historique des ${imports.total} import(s) de contenu.` : undefined}
      />

      {!imports ? (
        <p className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          Impossible de charger les imports.
        </p>
      ) : imports.items.length === 0 ? (
        <div className="card">
          <EmptyState
            title="Aucun import"
            hint="Lancez un import depuis la fiche d’une source pour remplir le catalogue."
          />
        </div>
      ) : (
        <Card className="overflow-hidden">
          <CardBody className="p-0">
            <ul className="divide-y divide-border">
              {imports.items.map((run) => {
                const metrics = run.metrics ?? {};
                const isDone = run.state === 'COMPLETED' || run.state === 'FAILED';
                return (
                  <li key={run.id}>
                    <Link
                      href={`/control/imports/${run.id}`}
                      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 transition-colors hover:bg-surface-2/60"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-accent">
                        <IconImports className="h-4 w-4" />
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold">{run.sourceName}</span>
                          <ImportStateBadge state={run.state} />
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                          <span className="font-mono">#{run.id.slice(0, 8)}</span>
                          {isDone && (
                            <>
                              <span>{metrics['created'] ?? 0} créées</span>
                              {(metrics['errors'] ?? 0) > 0 && (
                                <span className="text-danger">{metrics['errors']} erreur(s)</span>
                              )}
                            </>
                          )}
                        </span>
                      </span>

                      <time className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
                        <IconClock className="h-3.5 w-3.5" />
                        {formatDateTime(run.startedAt)}
                      </time>
                      <IconChevronRight className="h-4 w-4 shrink-0 text-muted/60" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      )}
    </>
  );
}
