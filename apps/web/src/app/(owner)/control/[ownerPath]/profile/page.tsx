'use client';

import { useEffect, useState } from 'react';
import { ownerApi } from '../../../../../features/owner/api/owner-api';

export default function OwnerProfilePage() {
  const [contact, setContact] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void ownerApi.profile().then((profile) => setContact(profile.whatsappContact ?? '')).catch(() => undefined); }, []);

  async function save(): Promise<void> {
    setBusy(true); setError(null); setSaved(false);
    try { await ownerApi.profileUpdate({ whatsappContact: contact.trim() || null }); setSaved(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Enregistrement impossible.'); }
    finally { setBusy(false); }
  }

  return (
    <main className="space-y-6 p-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">Profil</p>
        <h1 className="mt-2 text-2xl font-bold">Contact propriétaire</h1>
        <p className="mt-1 text-sm text-muted">Lien ou numéro WhatsApp affiché aux utilisateurs pour obtenir un code d’accès. Laissez vide pour revenir au lien par défaut.</p>
      </header>
      <section className="card space-y-4 p-5">
        <label className="block text-sm font-medium">WhatsApp
          <input
            value={contact}
            onChange={(event) => { setContact(event.target.value); setSaved(false); }}
            placeholder="+241 60 10 89 84 ou https://wa.me/…"
            className="mt-1.5 block w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
          />
        </label>
        <p className="text-xs text-muted">Accepte un numéro (sera transformé en lien wa.me) ou une URL WhatsApp complète.</p>
        <div className="flex items-center gap-3">
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button>
          {saved && <span className="text-xs font-semibold text-success">Enregistré</span>}
          {error && <span className="text-xs font-semibold text-danger">{error}</span>}
        </div>
      </section>
    </main>
  );
}
