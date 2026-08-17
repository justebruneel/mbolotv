'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { SourceCreateInput, SourceDetail } from '@mbolo/contracts';
import { ownerApi } from '../api/owner-api';

type Kind = SourceCreateInput['kind'];
type M3uMode = 'url' | 'file';

const KIND_LABELS: Record<Kind, string> = {
  M3U: 'Playlist M3U',
  XTREAM: 'Xtream Codes',
  MAC_PORTAL: 'MAG / Stalker (MAC)',
};

const KIND_HINTS: Record<Kind, string> = {
  M3U: 'Une URL directe vers un fichier .m3u / .m3u8, ou un fichier téléversé depuis cet ordinateur.',
  XTREAM: 'Serveur Xtream Codes : adresse, identifiant et mot de passe.',
  MAC_PORTAL: 'Portail Stalker / MAG : adresse et adresse MAC autorisée.',
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
      { key: 'url', label: 'Adresse du portail', type: 'url', placeholder: 'http://exemple.com/c/' },
      { key: 'macAddress', label: 'Adresse MAC', placeholder: '00:1A:79:XX:XX:XX' },
    ],
  };

const UPLOAD_MAX_BYTES = 512 * 1024 * 1024;

export function SourceForm({ source }: { source?: SourceDetail }) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>((source?.kind as Kind) ?? 'M3U');
  const [name, setName] = useState(source?.name ?? '');
  const [connection, setConnection] = useState<Record<string, string>>(() => {
    if (!source) return { url: '' };
    return Object.fromEntries(Object.entries(source.connectionMasked).map(([key, value]) => [key, value]));
  });
  const hasLocalPlaylist = Boolean(source && connection['filePath']);
  const [m3uMode, setM3uMode] = useState<M3uMode>(hasLocalPlaylist ? 'file' : 'url');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function setField(key: string, value: string) {
    setConnection((previous) => ({ ...previous, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    if (kind === 'M3U' && m3uMode === 'file' && !file) {
      setError('Sélectionnez un fichier .m3u à téléverser.');
      setBusy(false);
      return;
    }
    if (file && file.size > UPLOAD_MAX_BYTES) {
      setError(`Fichier trop volumineux (max ${UPLOAD_MAX_BYTES / (1024 * 1024)} Mo).`);
      setBusy(false);
      return;
    }
    if (file && !/\.m3u8?$/i.test(file.name)) {
      setError('Le fichier doit porter l’extension .m3u ou .m3u8.');
      setBusy(false);
      return;
    }

    try {
      if (source) {
        await ownerApi.sources.update(source.id, {
          name,
          priority: undefined,
          status: undefined,
        });
        if (file) await ownerApi.sources.uploadPlaylist(source.id, file);
      } else {
        const connectionInput =
          kind === 'M3U' && m3uMode === 'file'
            ? {}
            : Object.fromEntries(Object.entries(connection).filter(([, value]) => value !== ''));
        const created = await ownerApi.sources.create({ name, kind, connection: connectionInput });
        if (kind === 'M3U' && m3uMode === 'file') {
          await ownerApi.sources.uploadPlaylist(created.id, file as File);
        }
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
    <form onSubmit={submit} className="flex w-full max-w-lg flex-col gap-5">
      {!source && (
        <div>
          <span className="label">Type de source</span>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(KIND_LABELS) as Kind[]).map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => {
                  setKind(candidate);
                  setConnection({ url: '' });
                  setM3uMode('url');
                  setFile(null);
                }}
                className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  kind === candidate
                    ? 'border-accent bg-accent text-on-accent'
                    : 'border-border text-muted hover:border-accent/60 hover:text-foreground'
                }`}
              >
                {KIND_LABELS[candidate]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">{KIND_HINTS[kind]}</p>
        </div>
      )}

      <div>
        <label className="label" htmlFor="source-name">
          Nom de la source
        </label>
        <input
          id="source-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Ex. : Playlist famille"
          className="input"
          required
        />
      </div>

      {kind === 'M3U' && (
        <div>
          <span className="label">Origine de la playlist</span>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setM3uMode('url')}
              className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                m3uMode === 'url'
                  ? 'border-accent bg-accent text-on-accent'
                  : 'border-border text-muted hover:border-accent/60 hover:text-foreground'
              }`}
            >
              Depuis une URL
            </button>
            <button
              type="button"
              onClick={() => setM3uMode('file')}
              className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                m3uMode === 'file'
                  ? 'border-accent bg-accent text-on-accent'
                  : 'border-border text-muted hover:border-accent/60 hover:text-foreground'
              }`}
            >
              Téléverser un fichier
            </button>
          </div>
        </div>
      )}

      {kind === 'M3U' && m3uMode === 'file' && (
        <div>
          {hasLocalPlaylist && (
            <p className="mb-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted">
              Cette source utilise une playlist locale téléversée.
            </p>
          )}
          <label className="label" htmlFor="source-file">
            {hasLocalPlaylist ? 'Remplacer le fichier .m3u' : 'Fichier .m3u / .m3u8'}
          </label>
          <input
            id="source-file"
            type="file"
            accept=".m3u,.m3u8,audio/x-mpegurl,application/x-mpegurl,text/plain"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-2 file:text-sm file:font-medium file:text-on-accent"
          />
          {!source && (
            <p className="mt-1.5 text-xs text-muted">
              La source sera créée puis l’import démarrera automatiquement avec ce fichier.
            </p>
          )}
        </div>
      )}

      {!(kind === 'M3U' && m3uMode === 'file') &&
        CONNECTION_FIELDS[kind].map((field) => (
          <div key={field.key}>
            <label className="label" htmlFor={`source-${field.key}`}>
              {field.label}
            </label>
            <input
              id={`source-${field.key}`}
              type={field.type ?? 'text'}
              value={connection[field.key] ?? ''}
              onChange={(event) => setField(field.key, event.target.value)}
              placeholder={field.placeholder}
              className="input"
            />
          </div>
        ))}

      {error && (
        <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex gap-3">
        <button type="submit" disabled={busy} className="btn btn-primary">
          {busy
            ? file
              ? 'Téléversement…'
              : 'Enregistrement…'
            : source
              ? 'Enregistrer les modifications'
              : 'Créer la source'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/control/sources')}
          className="btn"
        >
          Annuler
        </button>
      </div>
    </form>
  );
}