'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../../shared/api/client';
import { Icon } from '@mbolo/ui';

const ROTATE_MS = 6_000;

interface FeaturedItem {
  channelId: string;
  programme: {
    id?: string;
    channelId: string;
    title: string;
    description: string | null;
    startsAt: string;
    endsAt: string;
    imageUrl: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    trailerUrl?: string | null;
    genres?: string[] | null;
    type?: string | null;
    year?: number | null;
  };
  channel?: { id: string; name: string; logoUrl: string | null };
}

export function FeaturedAuto() {
  const query = useQuery({
    queryKey: ['featured-auto'],
    queryFn: () => apiGet<FeaturedItem[]>('/epg/featured'),
    staleTime: 5 * 60_000,
  });

  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const startXRef = useRef<number | null>(null);
  const items = query.data ?? [];

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (items.length <= 1 || paused || reduced) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % items.length), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [items.length, paused]);

  useEffect(() => {
    const onVis = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  function onTouchStart(event: React.TouchEvent) {
    startXRef.current = event.touches[0].clientX;
  }
  function onTouchEnd(event: React.TouchEvent) {
    const start = startXRef.current;
    startXRef.current = null;
    if (start == null || items.length <= 1) return;
    const delta = event.changedTouches[0].clientX - start;
    if (Math.abs(delta) < 40) return;
    setIndex((value) => (delta < 0 ? (value + 1) % items.length : (value - 1 + items.length) % items.length));
    setPaused(true);
    window.setTimeout(() => setPaused(false), 3000);
  }

  if (query.isLoading) {
    return (
      <div className="mx-4 md:mx-10 h-64 animate-pulse rounded-2xl bg-surface" />
    );
  }
  if (items.length === 0) {
    // Reprise de l'ancien hero : un accueil correct même sans programme mis en avant.
    return (
      <div className="mx-4 py-10 md:mx-10 md:py-14">
        <p className="text-xs font-bold uppercase tracking-[0.3em] text-accent">Mbolo TV</p>
        <h1 className="mt-3 max-w-xl text-3xl font-black leading-tight md:text-5xl">Le direct, façon cinéma.</h1>
        <p className="mt-3 max-w-md text-sm text-muted">Des milliers de chaînes en direct. Choisissez une catégorie ci-dessous pour commencer.</p>
      </div>
    );
  }

  const item = items[index % items.length];
  const prog = item.programme;
  const channelName = item.channel?.name ?? 'Mbolo TV';
  const multiple = items.length > 1;
  const backdropOf = (p: FeaturedItem['programme']) =>
    (p as unknown as { backdropUrl?: string | null })?.backdropUrl ??
    (p as unknown as { posterUrl?: string | null })?.posterUrl ??
    p.imageUrl ??
    null;
  const hasAnyVisual = items.some((it) => backdropOf(it.programme));
  const trailer = (prog as unknown as { trailerUrl?: string | null })?.trailerUrl ?? null;

  return (
    <section
      className="relative mx-4 touch-pan-y overflow-hidden rounded-2xl border border-border bg-surface md:mx-10 md:bg-black"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Visuel : bande fixe sur mobile (les icônes EPG zoomées y restent
          cantonnées, texte lisible dessous), plein fond derrière le texte sur md+ */}
      <div className="relative h-44 w-full overflow-hidden md:absolute md:inset-0 md:h-full">
        {hasAnyVisual ? (
          items.map((it, position) => {
            const visual = backdropOf(it.programme);
            if (!visual) return null;
            const isPoster = !(it.programme as unknown as { backdropUrl?: string | null }).backdropUrl;
            return (
            <img
              key={`${it.channelId}-${it.programme.id ?? position}`}
              src={visual}
              alt=""
              loading={position === 0 ? 'eager' : 'lazy'}
              decoding="async"
              className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${position === index ? (isPoster ? 'opacity-60' : 'opacity-80') : 'opacity-0'}`}
            />
          );
        })
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-surface-3 to-bg" />
      )}
      {/* Dégradés allégés : l'image reste visible, le texte garde son contraste */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/35 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/50 via-transparent to-transparent" />

        {/* Pastilles de rotation (avec progression), comme sur l'accueil Netflix */}
        {multiple && (
          <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
            <div className="flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-2 backdrop-blur-md shadow-lg">
              {items.map((it, position) => (
                <button
                  key={`${it.channelId}-${it.programme.id ?? position}-dot`}
                  type="button"
                  aria-label={`Afficher ${it.programme.title}`}
                  onClick={() => setIndex(position)}
                  className={`relative h-[3px] overflow-hidden rounded-full transition-all duration-300 ${
                    position === index ? 'w-8 bg-white/30' : 'w-5 bg-white/20 hover:bg-white/40'
                  }`}
                >
                  {position === index && (
                    <span
                      key={`${index}-${paused ? 'p' : 'a'}`}
                      className="absolute inset-y-0 left-0 bg-white"
                      style={{
                        animation: `heroFill ${ROTATE_MS}ms linear forwards`,
                        animationPlayState: paused ? 'paused' : 'running',
                      }}
                    />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div
        key={`${item.channelId}-${prog.id ?? index}`}
        className="featured-fade relative bg-surface p-4 pb-5 md:bg-transparent md:p-10 md:pr-[40%]"
      >
        <p className="flex max-w-full flex-wrap items-center gap-2 text-xs font-black uppercase tracking-widest text-accent">
          <span className="inline-flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" /> À la une · Ce soir à {new Date(prog.startsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
          </span>
          {prog.type && <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent md:bg-white/20 md:text-white">{prog.type}</span>}
        </p>
        <h2 className="mt-3 line-clamp-2 text-2xl font-black leading-tight text-foreground md:text-4xl md:text-white">{prog.title}</h2>
        {prog.description && <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted md:text-base md:text-white/80">{prog.description}</p>}
        {(prog as unknown as { genres?: string[] })?.genres && (
          <p className="mt-1 text-xs text-muted md:text-white/60">{(prog as unknown as { genres: string[] }).genres.slice(0, 3).join(' · ')}</p>
        )}
        <p className="mt-1 text-xs text-muted md:text-white/60">{channelName} · {new Date(prog.startsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} – {new Date(prog.endsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</p>
        <div className="mt-4 flex flex-wrap gap-3 md:mt-5">
          <Link href={`/watch/${item.channelId}`} className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-black text-black shadow-lg hover:bg-white/90">
            <Icon.Play size={16} aria-hidden /> Voir
          </Link>
          <Link href={`/watch/${item.channelId}`} className="inline-flex items-center gap-2 rounded-full bg-foreground/10 px-6 py-3 text-sm font-bold text-foreground hover:bg-foreground/20 md:bg-white/15 md:text-white md:hover:bg-white/25">
            Plus d'infos
          </Link>
          {trailer && (
            <a href={trailer} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full bg-danger px-6 py-3 text-sm font-bold text-white hover:bg-danger/90">
              <Icon.Play size={14} aria-hidden /> Bande-annonce
            </a>
          )}
        </div>
        <p className="mt-4 text-[10px] text-muted md:text-white/40">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
      </div>
      <style>{`@keyframes heroFill { from { width: 0% } to { width: 100% } } @keyframes featuredFade { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } } .featured-fade { animation: featuredFade 500ms ease-out } @media (prefers-reduced-motion: reduce) { .featured-fade { animation: none !important } }`}</style>
    </section>
  );
}
