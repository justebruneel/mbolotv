import type { SourceDetail } from '@mbolo/contracts';
import { notFound } from 'next/navigation';
import { SourceActions } from '../../../../../features/owner/components/source-actions';
import { SourceForm } from '../../../../../features/owner/components/source-form';
import { serverOwnerFetch } from '../../../../../features/auth/server/owner-session';

function formatConnection(kind: string, masked: Record<string, string>): string[] {
  if (kind === 'M3U') return [masked['url'] ?? '—'];
  if (kind === 'XTREAM') {
    return [masked['url'] ?? '—', `Identifiant : ${masked['username'] ?? '—'}`];
  }
  return [masked['url'] ?? '—', `MAC : ${masked['macAddress'] ?? '—'}`];
}

export default async function SourceDetailPage({ params }: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await params;
  const source = await serverOwnerFetch<SourceDetail>(
    `/api/owner/sources/${sourceId}`,
  ).catch(() => null);

  if (!source) notFound();

  return (
    <>
      <h1 className="pageTitle mb-1">{source.name}</h1>
      <p className="mb-6 text-sm text-muted">
        {source.kind} · statut {source.status} · priorité {source.priority} ·{' '}
        {source.variantsCount} variante(s)
      </p>

      <div className="mb-8 rounded-xl border border-border bg-surface p-4">
        <h2 className="mb-2 text-sm font-semibold text-muted">Connexion (masquée)</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {formatConnection(source.kind, source.connectionMasked).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      <SourceActions sourceId={source.id} />

      <h2 className="mt-8 mb-3 font-semibold">Modifier la source</h2>
      <SourceForm source={source} />
    </>
  );
}