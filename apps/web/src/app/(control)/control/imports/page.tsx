import type { ImportRunListResponse } from '@mbolo/contracts';
import Link from 'next/link';
import { serverOwnerFetch } from '../../../../features/auth/server/owner-session';

const STATE_LABEL: Record<string, string> = {
  QUEUED: 'En file',
  FETCHING: 'Téléchargement',
  PARSING: 'Analyse',
  NORMALIZING: 'Normalisation',
  COMPLETED: 'Terminé',
  FAILED: 'Échec',
  CANCELED: 'Annulé',
};

const STATE_COLOR: Record<string, string> = {
  QUEUED: 'text-gray-400',
  FETCHING: 'text-blue-400',
  PARSING: 'text-blue-400',
  NORMALIZING: 'text-blue-400',
  COMPLETED: 'text-green-400',
  FAILED: 'text-red-400',
  CANCELED: 'text-gray-500',
};

export default async function ImportsPage() {
  const imports = await serverOwnerFetch<ImportRunListResponse>('/api/owner/imports').catch(
    () => null,
  );

  if (!imports) return <p className="text-muted">Impossible de charger les imports.</p>;

  return (
    <>
      <h1 className="pageTitle mb-6">Imports</h1>
      {imports.items.length === 0 ? (
        <p className="text-muted">Aucun import pour le moment.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {imports.items.map((run) => (
            <li key={run.id}>
              <Link
                href={`/control/imports/${run.id}`}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 transition-colors hover:border-accent"
              >
                <span className={`text-sm font-semibold ${STATE_COLOR[run.state] ?? ''}`}>
                  {STATE_LABEL[run.state] ?? run.state}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{run.sourceName}</span>
                {run.metrics && (
                  <span className="shrink-0 text-xs text-muted">
                    {run.metrics['channelsCreated'] ?? 0} chaînes
                  </span>
                )}
                <time className="shrink-0 text-xs text-muted">
                  {new Date(run.startedAt).toLocaleString('fr-FR')}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}