'use client';

import { Icon, Spinner } from '@mbolo/ui';
import { AccessForm, useAccessStatus } from '../../../features/auth/components/access';
import { DAY_MS, formatExpiresAt, formatRemaining } from '../../../shared/utils/formatDuration';

export default function AccessPage() {
  const { status, loading, refresh } = useAccessStatus();

  const remaining = status?.expiresAt ? new Date(status.expiresAt).getTime() - Date.now() : null;
  const active = Boolean(status?.active && remaining !== null && remaining > 0);

  return (
    <main className="mx-auto max-w-2xl animate-fade-in px-4 py-6 md:px-10">
      <h1 className="text-2xl font-black tracking-tight md:text-3xl">Mon accès</h1>
      <p className="mt-1 text-sm text-muted">
        L'accès est rattaché à cet appareil. Saisis un code — nouveau ou de renouvellement — pour le prolonger avant l'expiration.
      </p>

      {/* ===== Statut courant ===== */}
      <section
        className={`mt-6 rounded-2xl border p-5 ${
          active ? (remaining !== null && remaining < DAY_MS ? 'border-danger/40 bg-danger-muted' : 'border-border bg-surface') : 'border-danger/40 bg-danger-muted'
        }`}
      >
        {loading ? (
          <div className="flex items-center gap-3 text-sm font-semibold text-muted">
            <Spinner /> Vérification de votre accès…
          </div>
        ) : active && status?.expiresAt ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/15 text-accent">
                <Icon.Check size={18} aria-hidden />
              </span>
              <div>
                <p className="text-sm font-bold">
                  Accès actif{status.kind === 'PROMO' ? ' · promotionnel' : ''}
                </p>
                <p className="text-xs text-muted">Jusqu'au {formatExpiresAt(status.expiresAt)}</p>
              </div>
            </div>
            <span className={`rounded-full border px-3 py-1.5 text-xs font-bold tabular-nums ${remaining !== null && remaining < DAY_MS ? 'border-danger/40 text-danger' : 'border-border text-foreground'}`}>
              {remaining !== null ? `${formatRemaining(remaining)} restants` : ''}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-danger/15 text-danger">
              <Icon.AlertTriangle size={18} aria-hidden />
            </span>
            <div>
              <p className="text-sm font-bold text-danger">Accès inactif ou expiré</p>
              <p className="text-xs text-muted">Entre un code ci-dessous pour reprendre le direct.</p>
            </div>
          </div>
        )}
      </section>

      {/* ===== Saisie / prolongement ===== */}
      <div className="mt-6 flex justify-center">
        <AccessForm onRedeemed={() => refresh()} />
      </div>
    </main>
  );
}
