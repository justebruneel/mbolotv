'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { SourceCreateInput, SourceDetail } from '@mbolo/contracts';
import { ownerApi } from '../api/owner-api';

type Kind = SourceCreateInput['kind'];

const KIND_LABELS: Record<Kind, string> = {
  M3U: 'Playlist M3U (URL)',
  XTREAM: 'Xtream Codes',
  MAC_PORTAL: 'MAG / Stalker (MAC)',
};

const CONNECTION_FIELDS: Record<Kind, { key: string; label: string; type?: string; placeholder?: string }[]> =
  {
    M3U: [{ key: 'url', label: 'URL de la playlist M3U', type: 'url', placeholder: 'https://exemple.com/channels.m3u' }],
    XTREAM: [
      { key: 'url', label: 'URL de base', type: 'url', placeholder: 'http://exemple.com:8080' },
      { key: 'username', label: 'Identifiant' },
      { key: 'password', label: 'Mot de passe', type: 'password' },
    ],
    MAC_PORTAL: [
      {
        key: 'url',
        label: 'Adresse du portail',
        type: 'url',
        placeholder: 'http://exemple.com/c/',
      },
      { key: 'macAddress', label: 'Adresse MAC', placeholder: '00:1A:79:XX:XX:XX' },
    ],
  };

export function SourceForm({ source }: { source?: SourceDetail }) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>((source?.kind as Kind) ?? 'M3U');
  const [name, setName] = useState(source?.name ?? '');
  const [connection, setConnection] = useState<Record<string, string>>(() => {
    if (!source) return { url: '' };
    return Object.fromEntries(
      Object.entries(source.connectionMasked).map(([key, value]) => [key, value]),
    );
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function setField(key: string, value: string) {
    setConnection((previous) => ({ ...previous, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const input: SourceCreateInput = {
      name,
      kind,
      connection: Object.fromEntries(
        Object.entries(connection).filter(([, value]) => value !== ''),
      ),
    };
    try {
      if (source) {
        await ownerApi.sources.update(source.id, input);
      } else {
        await ownerApi.sources.create(input);
      }
      router.push('/control/sources');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enregistrement impossible.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-lg flex-col gap-4">
      {!source && (
        <div className="flex flex-wrap gap-2">
          {(Object.keys(KIND_LABELS) as Kind[]).map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => {
                setKind(candidate);
                setConnection({ url: '' });
              }}
              className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                kind === candidate
                  ? 'border-accent bg-accent text-on-accent'
                  : 'border-border text-muted hover:text-foreground'
              }`}
            >
              {KIND_LABELS[candidate]}
            </button>
          ))}
        </div>
      )}

      <label className="flex flex-col gap-1 text-sm">
        Nom de la source
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Ex. : Playlist famille"
          className="rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-accent"
        />
      </label>

      {CONNECTION_FIELDS[kind].map((field) => (
        <label key={field.key} className="flex flex-col gap-1 text-sm">
          {field.label}
          <input
            type={field.type ?? 'text'}
            value={connection[field.key] ?? ''}
            onChange={(event) => setField(field.key, event.target.value)}
            placeholder={field.placeholder}
            className="rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-accent"
          />
        </label>
      ))}

      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-accent px-4 py-2 font-semibold text-on-accent disabled:opacity-50"
        >
          {busy ? 'Enregistrement…' : source ? 'Enregistrer' : 'Créer la source'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/control/sources')}
          className="rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-foreground"
        >
          Annuler
        </button>
      </div>
    </form>
  );
}