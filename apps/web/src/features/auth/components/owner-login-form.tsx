'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ownerApi } from '../../owner/api/owner-api';
import { IconChevronLeft, IconKey, IconX } from '../../owner/components/ui/icons';

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
      const result = await ownerApi.auth.login({ email, password });
      if ('mfaRequired' in result && result.mfaRequired) {
        setChallengeToken(result.challengeToken);
        setStep('mfa');
        return;
      }
      // En développement, la session est créée directement (MFA désactivée).
      const next = new URLSearchParams(window.location.search).get('next') ?? '';
      router.replace(next.startsWith('/control') ? next : '/control');
      router.refresh();
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

  const errorBlock = error ? (
    <p className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
      <IconX className="h-4 w-4 shrink-0" />
      {error}
    </p>
  ) : null;

  if (step === 'credentials') {
    return (
      <form onSubmit={submitCredentials} className="flex flex-col gap-4">
        <div>
          <label className="label" htmlFor="owner-email">
            E-mail
          </label>
          <input
            id="owner-email"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor="owner-password">
            Mot de passe
          </label>
          <input
            id="owner-password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="input"
          />
        </div>
        {errorBlock}
        <button type="submit" disabled={busy} className="btn btn-primary">
          {busy ? 'Vérification…' : 'Se connecter'}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={submitMfa} className="flex flex-col gap-4">
      <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2.5 text-xs text-accent">
        Identifiants vérifiés. Saisissez le code à 6 chiffres de votre application
        d’authentification pour terminer la connexion.
      </div>
      <div>
        <label className="label" htmlFor="owner-totp">
          Code TOTP
        </label>
        <input
          id="owner-totp"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          maxLength={6}
          pattern="[0-9]{6}"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          className="input text-center font-mono text-lg tracking-[0.5em]"
        />
      </div>
      {errorBlock}
      <button type="submit" disabled={busy || code.length !== 6} className="btn btn-primary">
        <IconKey className="h-4 w-4" />
        {busy ? 'Vérification…' : 'Valider le code'}
      </button>
      <button
        type="button"
        onClick={() => {
          setStep('credentials');
          setCode('');
          setError(null);
        }}
        className="btn"
      >
        <IconChevronLeft className="h-4 w-4" />
        Revenir à la connexion
      </button>
    </form>
  );
}
