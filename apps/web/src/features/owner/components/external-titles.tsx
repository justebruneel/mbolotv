'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@mbolo/ui';
import type { BadgeTone } from '@mbolo/ui';
import { externalHostSchema } from '@mbolo/contracts';
import type { ExternalBotStatus, FichePreview, OwnerExternalTitle } from '@mbolo/contracts';
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

// Fenêtre d'intro (secondes) : le Player affiche « Sauter l'intro » quand la
// position est dans [début, fin). Saisie « m:ss » ou secondes brutes, vide =
// efface. Validation locale + serveur (début < fin).
function formatIntroSec(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const total = Math.max(0, Math.floor(value));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function parseIntroSec(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const value = Number(trimmed);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  const match = trimmed.match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/);
  if (!match) return undefined;
  const value = Number(match[1]) * 60 + Number(match[2]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function IntroEditor({ title, onChanged }: { title: OwnerExternalTitle; onChanged: () => void }) {
  const [start, setStart] = useState(() => formatIntroSec(title.introStartSec));
  const [end, setEnd] = useState(() => formatIntroSec(title.introEndSec));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasWindow = title.introStartSec !== null && title.introStartSec !== undefined
    && title.introEndSec !== null && title.introEndSec !== undefined;

  async function save(): Promise<void> {
    const nextStart = parseIntroSec(start);
    const nextEnd = parseIntroSec(end);
    if (nextStart === undefined || nextEnd === undefined) {
      setError('Format invalide : « m:ss » ou secondes (ex. 1:25 ou 85).');
      return;
    }
    if ((nextStart === null) !== (nextEnd === null)) {
      setError('Renseigne le début ET la fin, ou vide les deux pour effacer.');
      return;
    }
    if (nextStart !== null && nextEnd !== null && nextStart >= nextEnd) {
      setError('Le début doit précéder la fin.');
      return;
    }
    setBusy(true);
    try {
      await ownerApi.vod.external.updateTitle(title.id, { introStartSec: nextStart, introEndSec: nextEnd });
      setError(null);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Enregistrement impossible.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-border/70 bg-surface-2/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">Intro :</span>
        {hasWindow ? (
          <span className="text-xs text-muted">{formatIntroSec(title.introStartSec)} → {formatIntroSec(title.introEndSec)}</span>
        ) : (
          <span className="text-xs text-muted">non renseignée (pas de bouton « Sauter l’intro »)</span>
        )}
        <span className="flex-1" />
        <label className="flex items-center gap-1 text-xs text-muted">
          Début
          <input
            value={start}
            onChange={(event) => setStart(event.target.value)}
            placeholder="1:25"
            inputMode="numeric"
            className="w-20 rounded-md border border-border bg-surface px-2 py-1 text-sm font-mono"
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-muted">
          Fin
          <input
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            placeholder="2:10"
            inputMode="numeric"
            className="w-20 rounded-md border border-border bg-surface px-2 py-1 text-sm font-mono"
          />
        </label>
        <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
          {busy ? '…' : 'Enregistrer'}
        </button>
      </div>
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}

// Panneau du bot d'import : compteurs de la file, découverte des nouveautés
// (page 1 des listings) et traitement manuel d'un lot sans attendre le cron.
function BotPanel({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<ExternalBotStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setStatus(await ownerApi.vod.external.botStatus());
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Statut indisponible.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(action: 'discover' | 'tick'): Promise<void> {
    setBusy(action);
    setNotice(null);
    try {
      const result = await ownerApi.vod.external.botAction(action, 1);
      setNotice(
        action === 'discover'
          ? `${result.seeded ?? 0} nouvelle(s) fiche(s) ajoutée(s) à la file.`
          : `${result.processed ?? 0} fiche(s) traitée(s).`,
      );
      await load();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Action impossible.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Bot d&apos;import automatique</h3>
        {status ? (
          <Badge tone={status.enabled ? 'success' : 'default'}>{status.enabled ? 'Actif (cron 10 min)' : 'Inactif (EXTERNAL_BOT_ENABLED=0)'}</Badge>
        ) : null}
      </div>
      {status && (
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <span>File : <strong>{status.queue.pending}</strong> en attente · <strong>{status.queue.done}</strong> importés · {status.queue.failed} en échec{status.queue.running > 0 ? ` · ${status.queue.running} en cours` : ''}</span>
          <span className="text-muted">Publiés (24 h) : {status.publishedLast24h}</span>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void run('discover')}>
          {busy === 'discover' ? 'Découverte…' : 'Découvrir les nouveautés'}
        </button>
        <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void run('tick')}>
          {busy === 'tick' ? 'Traitement…' : 'Traiter un lot maintenant'}
        </button>
      </div>
      {notice && <p className="mt-2 text-sm text-accent">{notice}</p>}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
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

      {/* Bot d'import automatique : file d'attente + actions manuelles.
          Le toggle on/off se pilote via EXTERNAL_BOT_ENABLED (wrangler) ;
          la console montre la progression et permet d'amorcer sans cron. */}
      <BotPanel onChanged={() => { void reload(); }} />

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
                <IntroEditor key={`${title.id}:${title.introStartSec ?? ''}:${title.introEndSec ?? ''}`} title={title} onChanged={() => { void reload(); }} />
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
