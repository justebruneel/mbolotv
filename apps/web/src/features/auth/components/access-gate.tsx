'use client';

import type { AccessStatus } from '@mbolo/contracts';
import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../../../shared/api/client';

const WHATSAPP_URL = 'https://wa.me/qr/CPB7IL3GHAGIK1';

type GateProps = { enabled: boolean; children: React.ReactNode };

export function AccessGate({ enabled, children }: GateProps) {
  const [status, setStatus] = useState<AccessStatus | null>(enabled ? null : { active: true, expiresAt: null, kind: null, whatsappUrl: WHATSAPP_URL });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    apiGet<AccessStatus>('/access/status')
      .then((next) => { if (mounted) setStatus(next); })
      .catch(() => { if (mounted) setStatus({ active: false, expiresAt: null, kind: null, whatsappUrl: WHATSAPP_URL }); });
    return () => { mounted = false; };
  }, [enabled]);

  async function redeem(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = await apiPost<AccessStatus>('/access/redeem', { code: code.trim() });
      setStatus(next);
      setCode('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Code refusé.');
    } finally {
      setBusy(false);
    }
  }

  if (!enabled || status?.active) return <>{children}</>;
  if (!status) return <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted">Vérification de l’accès…</div>;

  return (
    <section className="mx-auto flex min-h-[65vh] w-full max-w-lg items-center px-5 py-12">
      <div className="card w-full p-7 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/15 text-2xl">🔐</div>
        <h1 className="text-xl font-bold tracking-tight">Accès propriétaire requis</h1>
        <p className="mt-2 text-sm leading-6 text-muted">Saisissez votre code d’accès pour regarder les chaînes. Un code ne fonctionne que sur un seul appareil.</p>
        <form onSubmit={redeem} className="mt-6 space-y-3">
          <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="Ex. MBLO-AB12CD34EF" autoComplete="one-time-code" className="w-full rounded-xl border border-border bg-surface-2 px-4 py-3 text-center font-mono text-sm uppercase tracking-wider focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
          <button type="submit" disabled={busy || !code.trim()} className="w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-on-accent disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Vérification…' : 'Activer mon accès'}</button>
        </form>
        {message && <p className="mt-3 text-sm text-danger">{message}</p>}
        <a href={status.whatsappUrl || WHATSAPP_URL} target="_blank" rel="noreferrer" className="mt-5 inline-flex text-sm font-semibold text-accent hover:underline">Demander un code sur WhatsApp</a>
        <p className="mt-3 text-xs text-muted">Codes disponibles : 7, 14 ou 30 jours. Les promos de test durent 24 heures.</p>
      </div>
    </section>
  );
}
