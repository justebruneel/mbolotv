'use client';

import type { Announcement, AnnouncementKind } from '@mbolo/contracts';
import { useEffect, useState } from 'react';
import { ownerApi } from '../../../../../features/owner/api/owner-api';

const KINDS: { value: AnnouncementKind; label: string }[] = [
  { value: 'INFO', label: 'Information' },
  { value: 'VERSION', label: 'Nouvelle version' },
  { value: 'PROMO', label: 'Promotion' },
];

const KIND_TONE: Record<AnnouncementKind, string> = {
  INFO: 'bg-surface-2 text-secondary',
  VERSION: 'bg-accent/15 text-accent',
  PROMO: 'bg-danger/15 text-danger',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function NotificationsAdminPage() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<AnnouncementKind>('INFO');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    ownerApi.notifications
      .list()
      .then((result) => setItems(result.items))
      .catch(() => setError('Connexion propriétaire requise.'));
  }, []);

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    setFlash(null);
    try {
      const created = await ownerApi.notifications.create({ title: title.trim(), body: body.trim(), kind });
      setItems((current) => [created, ...current]);
      setTitle('');
      setBody('');
      setFlash('Annonce enregistrée en brouillon. Publie-la pour la pousser aux appareils abonnés.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Création impossible.');
    } finally {
      setBusy(false);
    }
  }

  async function publish(id: string): Promise<void> {
    setError(null);
    try {
      const published = await ownerApi.notifications.publish(id);
      setItems((current) => current.map((item) => (item.id === id ? published : item)));
      setFlash('Annonce publiée : la push part vers tous les appareils abonnés à la prochaine minute.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Publication impossible.');
    }
  }

  async function remove(id: string): Promise<void> {
    if (!window.confirm('Supprimer cette annonce ?')) return;
    setError(null);
    try {
      await ownerApi.notifications.remove(id);
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Suppression impossible.');
    }
  }

  return (
    <main className="space-y-6 p-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">Groupe Nzogho</p>
        <h1 className="mt-2 text-2xl font-bold">Notifications</h1>
        <p className="mt-1 text-sm text-muted">
          Rédige les annonces poussées aux utilisateurs (sorties de version, promotions, services). Brouillon → Publier déclenche la notification.
        </p>
      </header>

      {/* ===== Rédaction ===== */}
      <section className="card p-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Nouvelle annonce</h2>
        <div className="mt-4 space-y-3">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Titre (80 caractères max)"
            maxLength={80}
            className="input w-full"
          />
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Message affiché dans la notification et dans « Quoi de neuf » (500 caractères max)"
            maxLength={500}
            rows={3}
            className="input w-full resize-y"
          />
          <div className="flex items-center gap-2">
            {KINDS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={kind === option.value}
                onClick={() => setKind(option.value)}
                className={`rounded-full border px-3.5 py-1.5 text-xs font-bold transition ${kind === option.value ? 'border-accent bg-accent text-on-accent' : 'border-border text-muted hover:bg-surface-2 hover:text-foreground'}`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => void create()} disabled={busy || title.trim().length < 3 || body.trim().length < 3} className="btn btn-primary">
              {busy ? 'Enregistrement…' : 'Enregistrer en brouillon'}
            </button>
            <span className="text-xs text-muted">{title.trim().length}/80 · {body.trim().length}/500</span>
          </div>
        </div>
      </section>

      {error && <p className="text-sm text-danger">{error}</p>}
      {flash && <p className="rounded-xl border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">{flash}</p>}

      {/* ===== Liste ===== */}
      <section className="card overflow-hidden">
        <h2 className="border-b border-border px-5 py-4 text-sm font-bold uppercase tracking-wide text-muted">Annonces ({items.length})</h2>
        {items.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">Aucune annonce pour le moment.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-start gap-3 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${KIND_TONE[item.kind]}`}>{item.kind}</span>
                    <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${item.status === 'SENT' ? 'bg-success/15 text-success' : 'bg-surface-2 text-muted'}`}>
                      {item.status === 'SENT' ? (item.sentAt ? 'Envoyée' : 'En file d’envoi') : 'Brouillon'}
                    </span>
                    <span className="text-xs text-faint">{formatDate(item.createdAt)}</span>
                  </div>
                  <p className="mt-1.5 text-sm font-bold">{item.title}</p>
                  <p className="mt-0.5 text-sm leading-snug text-muted">{item.body}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {item.status === 'DRAFT' && (
                    <button type="button" onClick={() => void publish(item.id)} className="btn btn-primary !px-3 !py-1.5 !text-xs">
                      Publier
                    </button>
                  )}
                  <button type="button" onClick={() => void remove(item.id)} className="btn btn-danger !px-3 !py-1.5 !text-xs">
                    Supprimer
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
