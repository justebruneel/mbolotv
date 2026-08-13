import type { AuditEntry } from '@mbolo/contracts';
import { serverOwnerFetch } from '../../../../features/auth/server/owner-session';

export default async function AuditPage() {
  const result = await serverOwnerFetch<{ items: AuditEntry[]; total: number }>(
    '/api/owner/audit?limit=200',
  ).catch(() => null);

  if (!result) return <p className="text-muted">Impossible de charger l’audit.</p>;

  return (
    <>
      <h1 className="pageTitle mb-6">Journal d’audit</h1>
      <p className="mb-4 text-sm text-muted">
        {result.total} entrée(s) — {result.items.length} affichée(s)
      </p>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-muted">
            <th className="py-2 pr-4 font-medium">Date</th>
            <th className="py-2 pr-4 font-medium">Action</th>
            <th className="py-2 pr-4 font-medium">Entité</th>
            <th className="py-2 font-medium">Détails</th>
          </tr>
        </thead>
        <tbody>
          {result.items.map((entry) => (
            <tr key={entry.id} className="border-b border-border/40">
              <td className="py-2 pr-4 whitespace-nowrap text-muted">
                {new Date(entry.createdAt).toLocaleString('fr-FR')}
              </td>
              <td className="py-2 pr-4 font-semibold">{entry.action}</td>
              <td className="py-2 pr-4 text-muted">
                {entry.entity}
                {entry.entityId ? ` #${entry.entityId.slice(0, 8)}` : ''}
              </td>
              <td className="max-w-md truncate py-2 text-muted">
                {entry.metadata ? JSON.stringify(entry.metadata) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}