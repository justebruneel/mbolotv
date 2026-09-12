'use client';

import { useEffect, useRef, useState } from 'react';
import { ownerApi } from '../api/owner-api';
import type { SourceCredentials } from '@mbolo/contracts';

// Révélation des identifiants = acte sensible (audit §4.4) : re-saisie du mot
// de passe owner exigée (vérifiée côté serveur), chaque affichage journalisé
// dans l'AuditLog, et effacement automatique après 30 s pour ne pas laisser
// les secrets à l'écran (ni dans l'historique de capture d'écran mental…).
const REVEAL_TTL_MS = 30_000;

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
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const hide = () => {
    setCredentials(null);
    setExpiresAt(null);
    setPassword('');
  };

  // Auto-masquage : l'affichage ne survit pas au délai, même sans action.
  const hideRef = useRef(hide);
  useEffect(() => {
    if (!credentials || expiresAt === null) return;
    const timer = window.setTimeout(() => hideRef.current(), Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [credentials, expiresAt]);

  // Le compte à rebours affiché s'égraine chaque seconde.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!credentials) return;
    const ticker = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(ticker);
  }, [credentials]);

  const reveal = async () => {
    if (!password) return;
    setLoading(true);
    setError(null);
    try {
      const data = await ownerApi.sources.revealCredentials(sourceId, password);
      setPassword('');
      setCredentials(data);
      setExpiresAt(Date.now() + REVEAL_TTL_MS);
    } catch (reason) {
      const status = (reason as Error & { status?: number }).status;
      setError(status === 403 ? 'Mot de passe incorrect.' : status === 429 ? 'Trop de tentatives — réessayez plus tard.' : 'Révélation impossible.');
    } finally {
      setLoading(false);
    }
  };

  if (credentials) {
    const rows = connectionRows(kind, credentials.connection);
    const remaining = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;
    return (
      <div>
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-danger uppercase tracking-wide">Identifiants en clair · affichage journalisé</span>
          <button type="button" onClick={hide} className="text-xs text-muted hover:text-foreground transition-colors">
            Masquer ({remaining} s)
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

  if (asking) {
    return (
      <form
        className="flex flex-col gap-3 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void reveal();
        }}
      >
        <p className="text-xs text-muted">Confirmez par votre mot de passe propriétaire — chaque révélation est enregistrée dans le journal d’audit.</p>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Mot de passe owner"
          autoComplete="current-password"
          className="input"
          autoFocus
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex gap-3">
          <button type="submit" disabled={loading || !password} className="btn btn-primary">
            {loading ? 'Vérification…' : 'Révéler'}
          </button>
          <button type="button" onClick={() => { setAsking(false); setError(null); setPassword(''); }} className="btn">
            Annuler
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <p className="text-xs text-muted">Les identifiants sont masqués par défaut</p>
      <button
        type="button"
        onClick={() => setAsking(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-4 py-2 text-xs font-semibold text-foreground transition-all hover:border-accent hover:text-accent"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        Afficher les identifiants
      </button>
    </div>
  );
}
