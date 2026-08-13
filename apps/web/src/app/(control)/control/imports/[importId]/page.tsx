import type { ImportRun } from '@mbolo/contracts';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { serverOwnerFetch } from '../../../../../features/auth/server/owner-session';

const METRIC_LABELS: Record<string, string> = {
  channelsCreated: 'Chaînes créées',
  channelsUpdated: 'Chaînes mises à jour',
  channelsSkipped: 'Chaînes ignorées',
  channelsFailed: 'Chaînes en échec',
  variantsCreated: 'Variantes créées',
  variantsUpdated: 'Variantes mises à jour',
  categoriesCreated: 'Catégories créées',
};

const STATE_LABEL: Record<string, string> = {
  QUEUED: 'En file',
  FETCHING: 'Téléchargement',
  PARSING: 'Analyse',
  NORMALIZING: 'Normalisation',
  COMPLETED: 'Terminé',
  FAILED: 'Échec',
  CANCELED: 'Annulé',
};

export default async function ImportDetailPage({
  params,
}: {
  params: Promise<{ importId: string }>;
}) {
  const { importId } = await params;
  const run = await serverOwnerFetch<ImportRun>(`/api/owner/imports/${importId}`).catch(
    () => null,
  );
  if (!run) notFound();

  return (
    <>
      <Link href="/control/imports" className="text-sm text-accent hover:underline">
        ← Imports
      </Link>
      <h1 className="pageTitle mb-1">Import #{run.id}</h1>
      <p className="mb-6 text-sm text-muted">
        Source : {run.sourceName} · État : {STATE_LABEL[run.state] ?? run.state}
      </p>

      {run.errorMessage && (
        <p className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {run.errorCode ? `[${run.errorCode}] ` : ''}
          {run.errorMessage}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Object.entries(METRIC_LABELS).map(([key, label]) => {
          const value = run.metrics?.[key] ?? 0;
          if (value === 0 && run.state !== 'COMPLETED') return null;
          return (
            <div key={key} className="rounded-xl border border-border bg-surface p-4">
              <p className="text-2xl font-bold">{value}</p>
              <p className="text-sm text-muted">{label}</p>
            </div>
          );
        })}
      </div>

      <p className="mt-6 text-sm text-muted">
        Début : {new Date(run.startedAt).toLocaleString('fr-FR')}
        {run.completedAt && (
          <> · Fin : {new Date(run.completedAt).toLocaleString('fr-FR')}</>
        )}
      </p>
    </>
  );
}