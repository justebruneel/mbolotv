'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ownerApi } from '../../owner/api/owner-api';

export function OwnerLoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await ownerApi.auth.login({ email, password });
      const next = new URLSearchParams(window.location.search).get('next') ?? '';
      router.replace(next.startsWith('/control') ? next : '/control/me');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec de connexion.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4">
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
        {busy ? 'Connexion…' : 'Se connecter'}
      </button>
    </form>
  );
}
