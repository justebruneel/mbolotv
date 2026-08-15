import type { SourceDetail } from '@mbolo/contracts';
import { notFound } from 'next/navigation';
import { serverOwnerFetch } from '../../../../../features/auth/server/owner-session';
import { SourceActions } from '../../../../../features/owner/components/source-actions';
import { SourceForm } from '../../../../../features/owner/components/source-form';
import { Card, CardBody, CardHeader } from '../../../../../features/owner/components/ui/card';
import { formatDateTime } from '../../../../../features/owner/components/ui/format';
import { IconKey, IconLink, IconTv } from '../../../../../features/owner/components/ui/icons';
import { BackLink, PageHeader } from '../../../../../features/owner/components/ui/page-header';
import {
  KindBadge,
  SourceStatusBadge,
} from '../../../../../features/owner/components/ui/status-badge';

function connectionRows(kind: string, masked: Record<string, string>) {
  if (kind === 'M3U') return [{ key: 'URL playlist', value: masked['url'] ?? '—' }];
  if (kind === 'XTREAM') {
    return [
      { key: 'URL de base', value: masked['url'] ?? '—' },
      { key: 'Identifiant', value: masked['username'] ?? '—' },
      { key: 'Mot de passe', value: masked['password'] ?? '••••••••' },
    ];
  }
  return [
    { key: 'Portail', value: masked['url'] ?? '—' },
    { key: 'Adresse MAC', value: masked['macAddress'] ?? '—' },
  ];
}

export default async function SourceDetailPage({ params }: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await params;
  const source = await serverOwnerFetch<SourceDetail>(`/api/owner/sources/${sourceId}`).catch(() => null);
  if (!source) notFound();

  return (
    <>
      <BackLink href="/control/sources" label="Retour aux sources" />
      <PageHeader
        title={source.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <KindBadge kind={source.kind} />
            <SourceStatusBadge status={source.status} />
            <span className="text-muted">Priorité {source.priority}</span>
          </span>
        }
        actions={<SourceActions sourceId={source.id} />}
      />

      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader icon={<IconLink className="h-4 w-4" />} title="Connexion" description="Identifiants masqués, jamais affichés en clair" />
          <CardBody className="p-0">
            <dl className="divide-y divide-border">
              {connectionRows(source.kind, source.connectionMasked).map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-4 px-5 py-3">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{row.key}</dt>
                  <dd className="truncate font-mono text-sm">{row.value}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<IconTv className="h-4 w-4" />} title="Informations" />
          <CardBody className="p-0">
            <dl className="divide-y divide-border">
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Variantes</dt>
                <dd className="font-mono text-sm">{source.variantsCount}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Priorité</dt>
                <dd className="font-mono text-sm">{source.priority}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Créée le</dt>
                <dd className="text-sm">{formatDateTime(source.createdAt)}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Dernière synchro</dt>
                <dd className="text-sm">{source.lastSyncedAt ? formatDateTime(source.lastSyncedAt) : 'Jamais'}</dd>
              </div>
            </dl>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          icon={<IconKey className="h-4 w-4" />}
          title="Modifier la source"
          description="Les champs vides sont conservés."
        />
        <CardBody>
          <SourceForm source={source} />
        </CardBody>
      </Card>
    </>
  );
}
