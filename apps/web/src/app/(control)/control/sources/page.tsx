import type { SourceResponse } from '@mbolo/contracts';
import { EmptyState } from '@mbolo/ui';
import Link from 'next/link';
import { serverOwnerFetch } from '../../../../features/auth/server/owner-session';
import { formatDate, formatRelative } from '../../../../features/owner/components/ui/format';
import {
  IconChevronRight,
  IconPlus,
  IconSources,
} from '../../../../features/owner/components/ui/icons';
import { PageHeader } from '../../../../features/owner/components/ui/page-header';
import { KindBadge, SourceStatusBadge } from '../../../../features/owner/components/ui/status-badge';

export default async function SourcesPage() {
  let sources: SourceResponse[];
  try {
    sources = await serverOwnerFetch<SourceResponse[]>('/api/owner/sources');
  } catch {
    return (
      <p className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
        Impossible de charger les sources.
      </p>
    );
  }

  return (
    <>
      <PageHeader
        title="Sources"
        description={`${sources.length} source(s) de contenu connectée(s) à la plateforme.`}
        actions={
          <Link href="/control/sources/new" className="btn btn-primary">
            <IconPlus className="h-4 w-4" />
            Nouvelle source
          </Link>
        }
      />

      {sources.length === 0 ? (
        <div className="card">
          <EmptyState
            title="Aucune source"
            hint="Créez votre première source (M3U, Xtream Codes ou MAG/Stalker) pour peupler le catalogue."
            action={
              <Link href="/control/sources/new" className="btn btn-primary mt-2">
                <IconPlus className="h-4 w-4" />
                Créer une source
              </Link>
            }
          />
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {sources.map((source) => (
            <li key={source.id}>
              <Link
                href={`/control/sources/${source.id}`}
                className="card card-interactive flex items-center gap-4 px-5 py-4"
              >
                <span className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-accent sm:flex">
                  <IconSources className="h-5 w-5" />
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold">{source.name}</span>
                    <SourceStatusBadge status={source.status} />
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <KindBadge kind={source.kind} />
                    <span>Priorité {source.priority}</span>
                    {source.lastSyncedAt ? (
                      <span>Synchro : {formatRelative(source.lastSyncedAt)}</span>
                    ) : (
                      <span>Jamais synchronisée</span>
                    )}
                  </span>
                </span>

                <time className="hidden shrink-0 text-xs text-muted md:block">
                  {formatDate(source.createdAt)}
                </time>
                <IconChevronRight className="h-4 w-4 shrink-0 text-muted/60" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
