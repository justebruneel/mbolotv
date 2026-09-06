'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@mbolo/ui';
import type { BadgeTone } from '@mbolo/ui';
import { externalHostSchema } from '@mbolo/contracts';
import type { FichePreview, OwnerExternalTitle } from '@mbolo/contracts';
import { ownerApi } from '../api/owner-api';

// Hosts résolus en direct par les extracteurs ; les autres sont publiés en
// repli iframe (embed lu tel quel) en attendant leur extracteur.
const SUPPORTED_HOSTS = new Set<string>(externalHostSchema.options);

const STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  OK: { label: 'OK', tone: 'success' },
  DEAD: { label: 'Mort', tone: 'danger' },
  ERROR: { label: 'Erreur', tone: 'warning' },
  UNKNOWN: { label: 'À vérifier', tone: 'default' },
};

function StatusPill({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, tone: 'default' as BadgeTone };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

// Import depuis fiche (French Stream, …) : coller l'URL → aperçu
// (métas + lecteurs) → publier la sélection (probe à la publication).
// Puis gestion des titres publiés : visibilité, re-vérification, retraits.
export function ExternalTitlesSection() {
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<FichePreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [titles, setTitles] = useState<OwnerExternalTitle[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Motifs par lecteur quand la publication échoue (422 : rien de vérifiable).
  const [publishErrors, setPublishErrors] = useState<Array<{ host: string; reason: string; detail?: string | null }>>([]);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const data = await ownerApi.vod.external.list({ limit: 50 });
      setTitles(data.items);
      setTotal(data.total);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Chargement impossible.');
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function runPreview(): Promise<void> {
    const ficheUrl = url.trim();
    if (!ficheUrl) return;
    setBusy('preview');
    setNotice(null);
    setPublishErrors([]);
    try {
      const data = await ownerApi.vod.external.preview(ficheUrl);
      setPreview(data);
      setSelected(new Set(data.players.map((player) => `${player.host}|${player.embedUrl}`)));
      setError(null);
    } catch (reason) {
      setPreview(null);
      setError(reason instanceof Error ? reason.message : 'Aperçu impossible.');
    } finally {
      setBusy(null);
    }
  }

  // Sélection par (host, embedUrl) exact : un même host peut lister plusieurs
  // embeds distincts (versions), cochables indépendamment.
  const playerKey = (host: string, embedUrl: string): string => `${host}|${embedUrl}`;

  async function runPublish(): Promise<void> {
    if (!preview || selected.size === 0) return;
    setBusy('publish');
    setPublishErrors([]);
    try {
      const players = preview.players
        .filter((player) => selected.has(playerKey(player.host, player.embedUrl)))
        .map((player) => ({ host: player.host, embedUrl: player.embedUrl }));
      const result = await ownerApi.vod.external.publish({ url: preview.ficheUrl, players });
      const rejected = result.rejected.length > 0 ? ` Rejetés : ${result.rejected.map((entry) => `${entry.host} (${entry.reason}${entry.detail ? ` — ${entry.detail}` : ''})`).join(', ')}.` : '';
      const skipped = result.skipped > 0 ? ` ${result.skipped} déjà présent(s).` : '';
      const pending = (result.pending ?? 0) > 0 ? ` ${result.pending} en attente de vérification (cron).` : '';
      setNotice(`« ${result.title} » : ${result.seen} détecté(s), ${result.inserted} publié(s).${skipped}${pending}${rejected}`);
      setPublishErrors([]);
      setPreview(null);
      setUrl('');
      setError(null);
      await reload();
    } catch (reason) {
      // La 422 embarque rejected[] : l'afficher lecteur par lecteur.
      const body = (reason as { body?: { rejected?: Array<{ host: string; reason: string; detail?: string | null }> } } | null)?.body;
      if (body?.rejected?.length) {
        setPublishErrors(body.rejected);
        setError(null);
      } else {
        setError(reason instanceof Error ? reason.message : 'Publication impossible.');
      }
    } finally {
      setBusy(null);
    }
  }

  function togglePlayer(host: string, embedUrl: string): void {
    const key = playerKey(host, embedUrl);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function mutate(key: string, action: () => Promise<unknown>, onDone?: () => void): Promise<void> {
    setBusy(key);
    try {
      await action();
      setError(null);
      onDone?.();
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Opération impossible.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card space-y-4 p-4">
      <div>
        <h2 className="text-lg font-bold">Titres externes (lecteurs tiers)</h2>
        <p className="mt-1 text-sm text-muted">
          Collez l’URL d’une fiche (French Stream, …) : l’aperçu liste les lecteurs détectés, la publication vérifie chacun (direct : probe complet ;
          autres : repli iframe) et ne garde que les sains — jamais de titre vide. La santé est re-vérifiée en continu (cron).
        </p>
      </div>

      {error && <p className="rounded-lg border border-danger/30 bg-danger-muted p-3 text-sm text-danger">{error}</p>}
      {publishErrors.length > 0 && (
        <div className="rounded-lg border border-danger/30 bg-danger-muted p-3 text-sm">
          <p className="mb-2 font-semibold text-danger">Aucun lecteur vérifiable — détail par lecteur :</p>
          <ul className="space-y-1 text-danger">
            {publishErrors.map((entry, index) => (
              <li key={`${entry.host}:${index}`}>
                <Badge tone="default">{entry.host}</Badge>{' '}{entry.reason}
                {entry.detail && <span className="block pl-1 text-xs opacity-80">{entry.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {notice && <p className="rounded-lg border border-accent/30 bg-accent/10 p-3 text-sm">{notice}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={url}
          placeholder="https://french-stream.one/index.php?newsid=…"
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void runPreview(); }}
          className="min-w-[260px] flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
        />
        <button type="button" className="btn btn-primary" disabled={!url.trim() || busy === 'preview'} onClick={() => void runPreview()}>
          {busy === 'preview' ? 'Analyse…' : 'Apercevoir'}
        </button>
      </div>

      {preview && (
        <div className="rounded-lg border border-border bg-surface-2/40 p-3">
          <div className="flex flex-wrap items-center gap-3">
            {preview.posterUrl && <img src={preview.posterUrl} alt="" className="h-24 w-16 rounded object-cover" />}
            <div className="min-w-0 flex-1">
              <p className="font-bold">{preview.title} {preview.year ? <span className="font-normal text-muted">({preview.year})</span> : null}</p>
              <p className="text-xs text-muted">{preview.site}{preview.newsid ? ` · #${preview.newsid}` : ''}</p>
            </div>
            <button type="button" className="btn btn-primary" disabled={selected.size === 0 || busy === 'publish'} onClick={() => void runPublish()}>
              {busy === 'publish' ? 'Publication…' : `Publier (${selected.size})`}
            </button>
          </div>
          <ul className="mt-3 space-y-1.5">
            {preview.players.map((player) => {
              const supported = SUPPORTED_HOSTS.has(player.host);
              return (
                <li key={`${player.host}:${player.embedUrl}`} className="flex flex-wrap items-center gap-2 text-sm">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={selected.has(`${player.host}:${player.embedUrl}`)} onChange={() => togglePlayer(player.host, player.embedUrl)} />
                    <Badge tone={supported ? 'accent' : 'default'}>{player.host}</Badge>
                  </label>
                  <span className="text-xs text-muted">{player.versions.join(', ')}{player.wrapped ? ' · wrapper suivi' : ''}</span>
                  {!supported && <span className="text-xs text-muted">— repli iframe (embed tel quel)</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">Titres publiés ({total})</h3>
          <button type="button" className="btn" disabled={busy === 'reload'} onClick={() => { setBusy('reload'); void reload().finally(() => setBusy(null)); }}>Actualiser</button>
        </div>
        {titles.length === 0 ? (
          <p className="text-sm text-muted">Aucun titre externe pour le moment.</p>
        ) : (
          <ul className="space-y-3">
            {titles.map((title) => (
              <li key={title.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-3">
                  {title.posterUrl && <img src={title.posterUrl} alt="" className="h-20 w-14 rounded object-cover" />}
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{title.title} {title.year ? <span className="font-normal text-muted">({title.year})</span> : null}</p>
                    <p className="text-xs text-muted">{title.site} · {title.healthySources} sain(s){title.deadSources > 0 ? ` · ${title.deadSources} mort(s)` : ''}{title.isVisible ? '' : ' · masqué'}</p>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === `vis:${title.id}`}
                    onClick={() => void mutate(`vis:${title.id}`, () => ownerApi.vod.external.updateTitle(title.id, { isVisible: !title.isVisible }))}
                  >
                    {title.isVisible ? 'Masquer' : 'Afficher'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy === `del:${title.id}`}
                    onClick={() => { if (window.confirm(`Supprimer « ${title.title} » et ses lecteurs ?`)) void mutate(`del:${title.id}`, () => ownerApi.vod.external.removeTitle(title.id)); }}
                  >
                    Supprimer
                  </button>
                </div>
                <ul className="mt-2 space-y-1.5">
                  {title.sources.map((source) => (
                    <li key={source.id} className={`flex flex-wrap items-center gap-2 text-sm ${source.isActive ? '' : 'opacity-60'}`}>
                      <Badge tone="accent">{source.host}</Badge>
                      <Badge tone={source.mode === 'iframe' ? 'default' : 'accent'}>{source.mode === 'iframe' ? 'iframe' : 'direct'}</Badge>
                      <span className="text-xs text-muted">{source.versions.join(', ')}</span>
                      <StatusPill status={source.lastStatus} />
                      {source.lastError && <span className="max-w-full truncate text-xs text-muted" title={source.lastError}>{source.lastError}</span>}
                      <span className="flex-1" />
                      <button
                        type="button"
                        className="btn"
                        disabled={busy === `re:${source.id}`}
                        onClick={() => {
                          setBusy(`re:${source.id}`);
                          ownerApi.vod.external.recheckSource(source.id)
                            .then((result) => {
                              setNotice(result.lastStatus === 'OK' ? `« ${title.title} » (${source.host}) : OK.` : `« ${title.title} » (${source.host}) : ${result.lastStatus} — ${result.lastError ?? ''}${result.detail ? ` (${result.detail})` : ''}`);
                              setError(null);
                              return reload();
                            })
                            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Revérification impossible.'))
                            .finally(() => setBusy(null));
                        }}
                      >
                        {busy === `re:${source.id}` ? 'Vérif…' : 'Revérifier'}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy === `tog:${source.id}`}
                        onClick={() => void mutate(`tog:${source.id}`, () => ownerApi.vod.external.updateSource(source.id, { isActive: !source.isActive }))}
                      >
                        {source.isActive ? 'Désactiver' : 'Activer'}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy === `rm:${source.id}`}
                        onClick={() => void mutate(`rm:${source.id}`, () => ownerApi.vod.external.removeSource(source.id))}
                      >
                        Retirer
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
