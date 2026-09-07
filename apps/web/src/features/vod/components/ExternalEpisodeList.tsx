'use client';

import { useEffect, useRef } from 'react';
import type { ExternalSourcePublic } from '@mbolo/contracts';

export interface ExternalEpisodeEntry {
  number: number;
  sources: ExternalSourcePublic[];
}

function versionLabel(versions: string[]): string | null {
  if (versions.includes('vff')) return 'VF';
  if (versions.includes('vfq')) return 'VFQ';
  if (versions.includes('vostfr')) return 'VOSTFR';
  return null;
}

// Liste d'épisodes façon Netflix (sans vignettes v1) : lignes complètes avec
// badge E, titre, méta langue/lecteurs et reprise. Sélection douce au clic
// sur la ligne, lecture immédiate sur le bouton play.
// Mobile : rail horizontal scrollable (une carte + aperçu de la suivante),
// l'épisode actif est maintenu en vue en défilement doux. Desktop (md+) :
// liste verticale classique.
export function ExternalEpisodeList({
  episodes,
  activeEpisode,
  progressEpisode,
  progressPct,
  watched,
  onSelect,
  onPlay,
}: {
  episodes: ExternalEpisodeEntry[];
  activeEpisode: number | null;
  progressEpisode?: number | null;
  progressPct?: number | null;
  watched: number[];
  onSelect: (episode: number) => void;
  onPlay: (episode: number) => void;
}) {
  const itemRefs = useRef(new Map<number, HTMLLIElement>());
  const firstRevealRef = useRef(true);

  // Maintien de l'épisode actif en vue (mobile uniquement : en md+ la liste
  // est verticale et entièrement visible). Premier cadrage instantané (pas
  // d'animation au chargement), suivants en smooth. block:'nearest' pour ne
  // pas faire sauter le scroll vertical de la page.
  useEffect(() => {
    if (activeEpisode === null) return;
    if (typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches) return;
    const el = itemRefs.current.get(activeEpisode);
    if (!el) return;
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior: ScrollBehavior = !reduced && !firstRevealRef.current ? 'smooth' : 'auto';
    firstRevealRef.current = false;
    el.scrollIntoView({ behavior, inline: 'center', block: 'nearest' });
  }, [activeEpisode, episodes.length]);

  if (episodes.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Épisodes</h2>
        <span className="text-xs text-muted">{episodes.length} épisode{episodes.length > 1 ? 's' : ''}</span>
      </div>
      <ul
        className="mt-2 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:none] md:mt-2 md:block md:space-y-0 md:divide-y md:divide-border md:overflow-visible md:rounded-xl md:border md:border-border md:pb-0 [&::-webkit-scrollbar]:hidden"
      >
        {episodes.map((entry) => {
          const best = entry.sources[0];
          const active = activeEpisode === entry.number;
          const isWatched = watched.includes(entry.number);
          const showProgress = progressEpisode === entry.number && progressPct !== null && progressPct !== undefined && progressPct > 0 && progressPct < 100;
          const label = versionLabel(best?.versions ?? []);
          return (
            <li
              key={entry.number}
              ref={(el) => {
                if (el) itemRefs.current.set(entry.number, el);
                else itemRefs.current.delete(entry.number);
              }}
              className={`w-[86%] shrink-0 snap-center overflow-hidden rounded-xl border border-border bg-surface md:w-auto md:shrink md:rounded-none md:border-0 md:bg-transparent ${active ? 'border-accent/60 md:border-0 md:bg-accent/5' : ''}`}
            >
              <div className="flex items-center gap-3 px-3 py-3 sm:px-4">
                <button
                  type="button"
                  onClick={() => onSelect(entry.number)}
                  aria-current={active ? 'true' : undefined}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span
                    className={`flex h-10 w-12 shrink-0 items-center justify-center rounded-lg text-sm font-black tabular-nums ${
                      active ? 'bg-accent text-white' : 'bg-surface-2 text-foreground'
                    }`}
                  >
                    {entry.number}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm font-semibold ${active ? 'text-accent' : ''}`}>
                      Épisode {entry.number}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
                      {label && <span className="font-bold text-foreground/80">{label}</span>}
                      <span>{entry.sources.length} lecteur{entry.sources.length > 1 ? 's' : ''}</span>
                      {isWatched && !showProgress && <span className="font-semibold text-accent">· Vu</span>}
                      {showProgress && <span>· {progressPct}% repris</span>}
                    </span>
                    {showProgress && (
                      <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-border">
                        <span className="block h-full rounded-full bg-accent" style={{ width: `${progressPct}%` }} />
                      </span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onPlay(entry.number)}
                  aria-label={`Lire l'épisode ${entry.number}`}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition ${
                    active
                      ? 'border-accent bg-accent text-white'
                      : 'border-border text-muted hover:border-accent hover:bg-accent hover:text-white'
                  }`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
