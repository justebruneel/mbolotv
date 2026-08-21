'use client';

import { useState } from 'react';
import { ownerApi } from '../api/owner-api';
import type { SourceCredentials } from '@mbolo/contracts';

function connectionRows(kind: string, connection: Record<string, string>) {
  if (kind === 'M3U') return [{ key: 'URL playlist', value: connection['url'] ?? '—' }];
  if (kind === 'XTREAM') {
    return [
      { key: 'URL de base', value: connection['url'] ?? '—' },
      { key: 'Identifiant', value: connection['username'] ?? '—' },
      { key: 'Mot de passe', value: connection['password'] ?? '—' },
    ];
  }
  return [
    { key: 'Portail', value: connection['url'] ?? '—' },
    { key: 'Adresse MAC', value: connection['macAddress'] ?? '—' },
  ];
}

export function SourceCredentials({ sourceId, kind }: { sourceId: string; kind: string }) {
  const [credentials, setCredentials] = useState<SourceCredentials | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reveal = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await ownerApi.sources.credentials(sourceId);
      setCredentials(data);
    } catch {
      setError('Erreur lors du chargement des identifiants');
    } finally {
      setLoading(false);
    }
  };

  const hide = () => setCredentials(null);

  if (credentials) {
    const rows = connectionRows(kind, credentials.connection);
    return (
      <div>
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-danger uppercase tracking-wide">Identifiants en clair</span>
          <button
            type="button"
            onClick={hide}
            className="text-xs text-muted hover:text-foreground transition-colors"
          >
            Masquer
          </button>
        </div>
        <dl className="divide-y divide-border">
          {rows.map((row) => (
            <div key={row.key} className="flex items-center justify-between gap-4 px-5 py-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{row.key}</dt>
              <dd className="font-mono text-sm select-all break-all text-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <p className="text-xs text-muted">Les identifiants sont masqués par défaut</p>
      <button
        type="button"
        onClick={() => void reveal()}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-4 py-2 text-xs font-semibold text-foreground transition-all hover:border-accent hover:text-accent disabled:opacity-50"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        {loading ? 'Chargement…' : 'Afficher les identifiants'}
      </button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
