'use client';

import type { AccessCode } from '@mbolo/contracts';
import { useEffect, useState } from 'react';
import { ownerApi } from '../../../../../features/owner/api/owner-api';
import { DAY_MS, formatExpiresAt, formatRemaining } from '../../../../../shared/utils/formatDuration';

function getRemainingLabel(code: AccessCode, now: number): { text: string; expired: boolean; soon: boolean } | null {
  if (!code.expiresAt) return null;
  const expiresMs = new Date(code.expiresAt).getTime();
  const remaining = expiresMs - now;
  if (remaining <= 0) return { text: 'expiré', expired: true, soon: false };
  return { text: formatRemaining(remaining), expired: false, soon: remaining < DAY_MS };
}

function CodeRow({ code, now, busy, onRevoke }: { code: AccessCode; now: number; busy: boolean; onRevoke: (id: string) => void }) {
  const remainingInfo = code.deviceBound ? getRemainingLabel(code, now) : null;
  const isExpired = remainingInfo?.expired ?? false;
  const isSoon = remainingInfo?.soon ?? false;
  const statusLabel = !code.active ? 'Révoqué' : isExpired ? 'Expiré' : 'Actif';
  const statusClass = !code.active ? 'text-muted' : isExpired ? 'text-danger' : isSoon ? 'text-danger' : 'text-success';

  return (
    <div className="flex flex-wrap items-center gap-3 p-4">
      <div className="min-w-[180px] flex-1">
        <code className="font-mono text-sm">••••{code.codeLast4}</code>
        <p className="mt-1 text-xs text-muted">
          {code.kind === 'PROMO' ? 'Promo 24 h' : `${code.durationHours / 24} jours`} ·{' '}
          {code.deviceBound ? (
            code.expiresAt ? (
              <span title={`Expire le ${formatExpiresAt(code.expiresAt)}`} className={isExpired ? 'text-danger font-semibold' : isSoon ? 'text-danger' : ''}>
                expire le {formatExpiresAt(code.expiresAt)} · {remainingInfo?.text}
              </span>
            ) : (
              'appareil lié'
            )
          ) : (
            'non utilisé'
          )}
        </p>
        {code.deviceBound && code.expiresAt && (
          <p className="mt-1 text-xs font-mono text-faint" title={code.expiresAt}>
            Échéance : {formatExpiresAt(code.expiresAt)}
          </p>
        )}
        <p className="mt-1 text-xs text-faint">Créé le {formatExpiresAt(code.createdAt)}</p>
      </div>
      <span className={`text-xs font-semibold ${statusClass}`}>{statusLabel}</span>
      {code.active && (
        <button className="btn btn-danger" disabled={busy} onClick={() => onRevoke(code.id)}>
          Révoquer
        </button>
      )}
    </div>
  );
}

export default function AccessControlPage() {
  const [codes, setCodes] = useState<AccessCode[]>([]);
  const [kind, setKind] = useState<'STANDARD' | 'PROMO'>('STANDARD');
  const [days, setDays] = useState<7 | 14 | 30>(7);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    ownerApi.accessCodes.list().then(setCodes).catch((reason) => setError(reason instanceof Error ? reason.message : 'Connexion propriétaire requise.'));
  }, []);

  // Compte à rebours live pour les codes liés (30s comme AccessTimeBadge)
  useEffect(() => {
    const hasBound = codes.some((c) => c.deviceBound && c.expiresAt);
    if (!hasBound) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [codes]);

  async function createCode(): Promise<void> {
    setBusy(true);
    setError(null);
    setNewCode(null);
    try {
      const created = await ownerApi.accessCodes.create(kind === 'PROMO' ? { kind } : { kind, durationDays: days });
      setNewCode(created.code);
      setCodes((current) => [created, ...current]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Création impossible.');
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string): Promise<void> {
    if (!window.confirm('Révoquer ce code ?')) return;
    setBusy(true);
    try {
      await ownerApi.accessCodes.revoke(id);
      setCodes((current) => current.map((code) => (code.id === id ? { ...code, active: false } : code)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Révocation impossible.');
    } finally {
      setBusy(false);
    }
  }
  async function copy(): Promise<void> {
    if (newCode) await navigator.clipboard.writeText(newCode);
  }

  if (error && codes.length === 0)
    return (
      <main className="p-6">
        <div className="card p-6 text-sm text-danger">
          {error}. <a className="font-semibold text-accent hover:underline" href="/owner/login">Se connecter</a>
        </div>
      </main>
    );
  return (
    <main className="space-y-6 p-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">Monétisation</p>
        <h1 className="mt-2 text-2xl font-bold">Codes d’accès</h1>
        <p className="mt-1 text-sm text-muted">Un code, un appareil. Les promos sont automatiquement limitées à 24 heures.</p>
      </header>
      <section className="card space-y-4 p-5">
        <h2 className="font-semibold">Générer un code</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            Type
            <select value={kind} onChange={(event) => setKind(event.target.value as 'STANDARD' | 'PROMO')} className="mt-1 block rounded-lg border border-border bg-surface-2 px-3 py-2">
              <option value="STANDARD">Standard</option>
              <option value="PROMO">Promo 24 h</option>
            </select>
          </label>
          {kind === 'STANDARD' && (
            <label className="text-sm">
              Durée
              <select value={days} onChange={(event) => setDays(Number(event.target.value) as 7 | 14 | 30)} className="mt-1 block rounded-lg border border-border bg-surface-2 px-3 py-2">
                <option value={7}>7 jours</option>
                <option value={14}>14 jours</option>
                <option value={30}>30 jours</option>
              </select>
            </label>
          )}
          <button className="btn btn-primary" disabled={busy} onClick={createCode}>
            {busy ? 'Génération…' : 'Générer'}
          </button>
        </div>
        {newCode && (
          <div className="rounded-xl border border-success/30 bg-success/10 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-success">Copiez-le maintenant, il ne sera plus affiché</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <code className="rounded bg-surface-2 px-3 py-2 font-mono text-lg font-bold tracking-widest">{newCode}</code>
              <button className="btn" onClick={copy}>
                Copier
              </button>
            </div>
          </div>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
      </section>
      <section className="card overflow-hidden">
        <div className="border-b border-border p-5">
          <h2 className="font-semibold">Codes émis</h2>
        </div>
        <div className="divide-y divide-border/70">
          {codes.length === 0 ? (
            <p className="p-5 text-sm text-muted">Aucun code pour l’instant.</p>
          ) : (
            codes.map((code) => <CodeRow key={code.id} code={code} now={now} busy={busy} onRevoke={revoke} />)
          )}
        </div>
      </section>
    </main>
  );
}
