import type { SourceResponse } from '@mbolo/contracts';
import Link from 'next/link';
import { serverOwnerFetch } from '../../../../features/auth/server/owner-session';

const STATUS_DOT: Record<string, string> = {
  CONNECTED: 'bg-green-500',
  DEGRADED: 'bg-amber-500',
  FAILED: 'bg-red-500',
  PENDING: 'bg-gray-500',
};

const KIND_LABEL: Record<string, string> = {
  M3U_URL: 'M3U (URL)',
  XTREAM: 'Xtream Codes',
  MAC_ADDRESS: 'MAG / Stalker',
};

export default async function SourcesPage() {
  let sources: SourceResponse[];
  try {
    sources = await serverOwnerFetch<SourceResponse[]>('/api/owner/sources');
  } catch {
    return <p className="text-muted">Impossible de charger les sources.</p>;
  }

  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="pageTitle mb-0">Sources</h1>
        <Link
          href="/control/sources/new"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent"
        >
          + Nouvelle source
        </Link>
      </div>

      {sources.length === 0 ? (
        <p className="text-muted">
          Aucune source. Créez votre première source (M3U, Xtream ou MAG) pour commencer.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sources.map((source) => (
            <li key={source.id}>
              <Link
                href={`/control/sources/${source.id}`}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 transition-colors hover:border-accent"
              >
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[source.status] ?? 'bg-gray-500'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{source.name}</span>
                  <span className="block text-xs text-muted">
                    {KIND_LABEL[source.kind] ?? source.kind} · priorité {source.priority}
                  </span>
                </span>
                <time className="shrink-0 text-xs text-muted">
                  Créée le {new Date(source.createdAt).toLocaleDateString('fr-FR')}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}