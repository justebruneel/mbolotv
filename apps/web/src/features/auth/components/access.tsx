'use client';

import type { AccessStatus } from '@mbolo/contracts';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Icon, Logo, Spinner } from '@mbolo/ui';
import { apiGet, apiPost } from '../../../shared/api/client';

const WHATSAPP_URL = 'https://wa.me/qr/CPB7IL3GHAGIK1';
const WHATSAPP_NUMBER = '+241 60 10 89 84';

/** Statut d'accès de l'appareil ; `loading` distingue la vérification du verrou. */
export function useAccessStatus(): { status: AccessStatus | null; loading: boolean } {
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let mounted = true;
    apiGet<AccessStatus>('/access/status')
      .then((next) => { if (mounted) setStatus(next); })
      .catch(() => { if (mounted) setStatus({ active: false, expiresAt: null, kind: null, whatsappUrl: WHATSAPP_URL }); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);
  return { status, loading };
}

async function redeem(code: string): Promise<AccessStatus> {
  return apiPost<AccessStatus>('/access/redeem', { code });
}

/** Écran de vérification plein écran, aux couleurs de la marque. */
export function AccessChecking({ label = 'Vérification de votre accès…' }: { label?: string }) {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center gap-5 overflow-hidden px-6">
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-accent/10 blur-[120px]" />
      <Logo />
      <div className="flex items-center gap-3 text-sm font-semibold text-muted">
        <Spinner /> {label}
      </div>
    </div>
  );
}

/** Formulaire d'activation du code d'accès (utilisé par le portail d'entrée). */
export function AccessForm({ onRedeemed }: { onRedeemed: (status: AccessStatus) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!code.trim()) return;
    setBusy(true); setMessage(null);
    try {
      const next = await redeem(code.trim());
      setCode('');
      onRedeemed(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Code refusé.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card w-full max-w-md p-7 text-center shadow-2xl backdrop-blur">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/15 text-accent">
        <Icon.Key size={22} aria-hidden />
      </div>
      <h2 className="text-lg font-bold tracking-tight">Entrer votre code d'accès</h2>
      <p className="mt-2 text-sm leading-6 text-muted">Un code ne fonctionne que sur un seul appareil.</p>
      <form onSubmit={submit} className="mt-5 space-y-3">
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="Ex. MBLO-AB12CD34EF"
          autoComplete="one-time-code"
          className="w-full rounded-xl border border-border bg-surface-2 px-4 py-3 text-center font-mono text-sm uppercase tracking-wider focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
        />
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="w-full rounded-xl bg-accent px-4 py-3 text-sm font-bold uppercase tracking-wide text-on-accent transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Vérification…' : 'Activer mon accès'}
        </button>
      </form>
      {message && <p className="mt-3 text-sm text-danger">{message}</p>}
      <a href={WHATSAPP_URL} target="_blank" rel="noreferrer" className="mt-5 inline-flex text-sm font-semibold text-accent hover:underline">
        Demander un code sur WhatsApp
      </a>
      <p className="mt-2 text-xs text-muted">{WHATSAPP_NUMBER}</p>
    </div>
  );
}

/**
 * Garde silencieux des pages internes : si l'appareil n'a pas d'accès actif,
 * renvoie vers le portail d'entrée (/). Pendant la vérification, un écran
 * de marque évite tout flash de contenu.
 */
export function AccessGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { status, loading } = useAccessStatus();
  useEffect(() => {
    if (!loading && status && !status.active) router.replace('/');
  }, [loading, status, router]);
  if (loading || !status?.active) {
    return <AccessChecking label={loading ? 'Vérification de votre accès…' : 'Accès requis — ouverture du portail…'} />;
  }
  return <>{children}</>;
}
