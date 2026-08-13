'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ownerApi } from '../../owner/api/owner-api';

export function OwnerLoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<'credentials' | 'mfa'>('credentials');
  const [challengeToken, setChallengeToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitCredentials(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const challenge = await ownerApi.auth.login({ email, password });
      setChallengeToken(challenge.challengeToken);
      setStep('mfa');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec de connexion.');
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await ownerApi.auth.mfaVerify(challengeToken, code);
      const next = new URLSearchParams(window.location.search).get('next') ?? '';
      router.replace(next.startsWith('/control') ? next : '/control');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Code invalide.');
    } finally {
      setBusy(false);
    }
  }

  if (step === 'credentials') {
    return (
      <form onSubmit={submitCredentials} className="flex w-full max-w-sm flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          E-mail
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Mot de passe
          <input
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-accent"
          />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-accent px-4 py-2 font-semibold text-on-accent transition-opacity disabled:opacity-50"
        >
          {busy ? 'Vérification…' : 'Se connecter'}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={submitMfa} className="flex w-full max-w-sm flex-col gap-4">
      <p className="text-sm text-muted">
        Saisissez le code à 6 chiffres de votre application d&apos;authentification.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        Code TOTP
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          maxLength={6}
          pattern="[0-9]{6}"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          className="rounded-lg border border-border bg-surface px-3 py-2 tracking-[0.5em] outline-none focus:border-accent"
        />
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={busy || code.length !== 6}
        className="rounded-lg bg-accent px-4 py-2 font-semibold text-on-accent transition-opacity disabled:opacity-50"
      >
        {busy ? 'Vérification…' : 'Valider le code'}
      </button>
      <button
        type="button"
        onClick={() => setStep('credentials')}
        className="text-sm text-muted hover:text-foreground"
      >
        ← Revenir
      </button>
    </form>
  );
}