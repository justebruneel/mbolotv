'use client';

import type { Programme } from '@mbolo/contracts';
import { Icon } from '@mbolo/ui';
import Link from 'next/link';
import { useEffect } from 'react';
import { buildWatchHref } from '../../live-tv/utils';
import { RemindButton } from './RemindButton';

export interface SelectedProgramme {
  programme: Programme;
  channelName: string;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Fiche programme : visuel TMDB, métadonnées (type, année, saison/épisode,
 * genres), accès direct à la chaîne et bouton de rappel. Feuille en bas
 * d'écran sur mobile, modale centrée au-dessus.
 */
export function ProgrammeDetail({ selected, category, onClose }: { selected: SelectedProgramme; category?: string; onClose: () => void }) {
  const { programme, channelName } = selected;
  const enriched = programme as Programme & {
    type?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    genres?: string[] | null;
    year?: number | null;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
  };
  const image = enriched.backdropUrl ?? enriched.posterUrl ?? programme.imageUrl ?? null;
  const durationMin = Math.max(0, Math.round((new Date(programme.endsAt).getTime() - new Date(programme.startsAt).getTime()) / 60_000));

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={programme.title}>
      <button type="button" aria-label="Fermer la fiche programme" className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg animate-slide-up overflow-hidden rounded-t-2xl border border-border bg-surface shadow-2xl sm:mx-4 sm:rounded-2xl">
        {image && (
          <div className="h-40 w-full overflow-hidden bg-surface-2">
            <img src={image} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Fermer"
          className="absolute right-3 top-3 rounded-full bg-black/50 p-2 text-white backdrop-blur transition hover:bg-black/70"
        >
          <Icon.X size={16} aria-hidden />
        </button>

        <div className="max-h-[70vh] overflow-y-auto p-5">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
            {enriched.type && <span className="rounded bg-surface-2 px-1.5 py-0.5">{enriched.type}</span>}
            {enriched.year && <span>{enriched.year}</span>}
            {enriched.seasonNumber ? <span>S{enriched.seasonNumber} E{enriched.episodeNumber ?? ''}</span> : null}
            {enriched.genres && enriched.genres.length > 0 && <span>{enriched.genres.slice(0, 3).join(' · ')}</span>}
          </div>

          <h2 className="mt-2 text-lg font-extrabold leading-tight">{programme.title}</h2>
          <p className="mt-1 text-sm text-muted">
            {channelName} · {formatTime(programme.startsAt)} – {formatTime(programme.endsAt)} · {durationMin} min
          </p>

          {programme.description && <p className="mt-3 text-sm leading-relaxed text-secondary">{programme.description}</p>}

          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            <Link
              href={buildWatchHref(programme.channelId, { category })}
              onClick={onClose}
              className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-bold text-on-accent transition hover:bg-accent/90"
            >
              <Icon.Play size={14} aria-hidden /> Regarder {channelName}
            </Link>
            <RemindButton
              programme={{
                id: programme.id,
                channelId: programme.channelId,
                channelName,
                title: programme.title,
                startsAt: programme.startsAt,
                endsAt: programme.endsAt,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
