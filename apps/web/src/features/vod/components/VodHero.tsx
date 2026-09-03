'use client';

import { Icon } from '@mbolo/ui';
import type { VodItem } from '@mbolo/contracts';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../../../shared/stores/settings';

const ROTATE_MS = 7_000;

// Héros plein écran façon Netflix : backdrop 16:9 flouté, titre XXL, badges
// (type, note, catégorie), « Lecture » / « Plus d'infos ». Rotation auto des
// derniers ajouts, pause au survol et sous prefers-reduced-motion, swipe
// mobile. Le backdrop = poster 2:3 très zoomé (le fournisseur ne livre pas
// de paysage) : crop central + voile dégradé vers la page.
export function VodHero({ items }: { items: VodItem[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const startXRef = useRef<number | null>(null);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (items.length <= 1 || paused || reduced) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % items.length), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [items.length, paused]);

  if (items.length === 0) return null;
  const item = items[index % items.length];
  const multiple = items.length > 1;

  return (
    <section
      aria-label="À la une"
      className="relative mb-8 overflow-hidden rounded-2xl border border-border bg-surface"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onTouchStart={(event) => { startXRef.current = event.touches[0].clientX; }}
      onTouchEnd={(event) => {
        const start = startXRef.current;
        startXRef.current = null;
        if (start == null || !multiple) return;
        const delta = event.changedTouches[0].clientX - start;
        if (Math.abs(delta) < 40) return;
        setIndex((value) => (delta < 0 ? (value + 1) % items.length : (value - 1 + items.length) % items.length));
      }}
    >
      <div className="relative h-[380px] sm:h-[440px] md:h-[500px]">
        {item.posterUrl && (
          <img
            key={item.id}
            src={item.posterUrl.replace(/w600_and_h900[^/]*\//, 'w1280_and_h720_bestv2/')}
            alt=""
            className="absolute inset-0 h-full w-full scale-110 object-cover object-top opacity-90"
            loading="eager"
            decoding="async"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/55 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/25 to-transparent" />

        <div className="absolute inset-x-0 bottom-0 p-5 md:p-10">
          <p className="text-xs font-bold uppercase tracking-[0.3em] text-accent">{item.kind === 'SERIES' ? 'Série à la une' : 'Film à la une'}</p>
          <h1 className="mt-2 max-w-2xl text-3xl font-black leading-tight text-white drop-shadow-lg md:text-5xl">{item.title}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-white/80 md:text-sm">
            {item.rating !== null && item.rating > 0 && (
              <span className="inline-flex items-center gap-1 font-bold text-accent"><Icon.Star size={14} /> {item.rating.toFixed(1)}</span>
            )}
            {item.category && <span className="max-w-[16rem] truncate">{item.category}</span>}
            {item.addedAt && <span>{new Date(item.addedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}</span>}
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link href={`/vod/${item.id}`} className="btn btn-primary">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
              Lecture
            </Link>
            <Link href={`/vod/${item.id}`} className="btn bg-white/15 text-white backdrop-blur hover:bg-white/25">
              Plus d'infos
            </Link>
          </div>
        </div>

        {multiple && (
          <>
            <div className="absolute right-4 top-4 flex gap-1.5">
              {items.map((entry, position) => (
                <button key={entry.id} type="button" aria-label={`Aller à la position ${position + 1}`} onClick={() => setIndex(position)}
                  className={`h-1.5 rounded-full transition-all ${position === index % items.length ? 'w-6 bg-accent' : 'w-1.5 bg-white/40 hover:bg-white/70'}`} />
              ))}
            </div>
            <div className="absolute inset-y-0 left-0 flex items-center opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100">
              <button type="button" aria-label="Précédent" onClick={() => setIndex((value) => (value - 1 + items.length) % items.length)}
                className="m-2 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur hover:bg-black/70">
                <Icon.ChevronLeft size={20} />
              </button>
            </div>
            <div className="absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100">
              <button type="button" aria-label="Suivant" onClick={() => setIndex((value) => (value + 1) % items.length)}
                className="m-2 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur hover:bg-black/70">
                <Icon.ChevronRight size={20} />
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

// Usage interne reprise : le tile a déjà sa propre logique.
export function HeroProgressHint({ id }: { id: string }) {
  const progress = useSettingsStore((state) => state.vodProgress[id]);
  if (!progress || progress.duration <= 0 || progress.position <= 30) return null;
  return <p className="text-xs text-white/70">Reprise à {Math.round((progress.position / progress.duration) * 100)} %</p>;
}
