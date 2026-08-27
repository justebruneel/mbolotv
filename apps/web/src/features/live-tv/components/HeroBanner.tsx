'use client';

import type { Channel } from '@mbolo/contracts';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { FavoriteButton } from '@mbolo/ui';
import { useFavoritesStore } from '../../../shared/stores/favorites';
import { channelBadge } from '../utils';

const ROTATE_MS = 5_000;

// Hero Netflix-style : rotation 5s, swipe tactile, pastilles avec progression.
export function HeroBanner({ channels }: { channels: Channel[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const startXRef = useRef<number | null>(null);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (channels.length <= 1 || paused || reduced) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % channels.length), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [channels.length, paused]);

  useEffect(() => {
    const onVis = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  function onTouchStart(event: React.TouchEvent) {
    startXRef.current = event.touches[0].clientX;
  }
  function onTouchEnd(event: React.TouchEvent) {
    if (startXRef.current == null) return;
    const delta = event.changedTouches[0].clientX - startXRef.current;
    startXRef.current = null;
    if (Math.abs(delta) < 40) return;
    setIndex((value) => (delta < 0 ? (value + 1) % channels.length : (value - 1 + channels.length) % channels.length));
    setPaused(true);
    window.setTimeout(() => setPaused(false), 3000);
  }

  if (channels.length === 0) {
    return (
      <div className="relative h-[52vh] min-h-[340px] w-full bg-gradient-to-b from-surface-2 to-bg">
        <div className="absolute inset-0 flex items-center px-6 md:px-16">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.3em] text-accent">Mbolo TV</p>
            <h1 className="mt-3 max-w-xl text-3xl font-black leading-tight md:text-5xl">Le direct, façon cinéma.</h1>
            <p className="mt-3 max-w-md text-sm text-muted">Des milliers de chaînes en direct. Choisissez une catégorie ci-dessous pour commencer.</p>
          </div>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-bg to-transparent" />
      </div>
    );
  }

  return (
    <div
      className="relative h-[52svh] min-h-[360px] w-full overflow-hidden touch-pan-y md:h-[78vh] md:min-h-[520px] md:max-h-[760px]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {channels.map((channel, position) => (
        <HeroSlide key={channel.id} channel={channel} active={position === index} />
      ))}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[42%] bg-gradient-to-t from-bg via-bg/70 to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 left-0 w-[72%] bg-gradient-to-r from-bg via-bg/60 to-transparent md:w-[58%]" />

      <div className="pointer-events-none absolute bottom-8 left-1/2 z-30 flex -translate-x-1/2 justify-center pb-[env(safe-area-inset-bottom)]">
        <div className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-2 backdrop-blur-md shadow-lg">
          {channels.map((channel, position) => (
            <button
              key={channel.id}
              type="button"
              aria-label={`Mettre en avant ${channel.name}`}
              onClick={() => setIndex(position)}
              className={`pointer-events-auto relative h-[3px] overflow-hidden rounded-full transition-all duration-300 ${
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
      <style>{`@keyframes heroFill { from { width: 0% } to { width: 100% } } @keyframes kenBurns { from { transform: scale(1) } to { transform: scale(1.08) } } @media (prefers-reduced-motion: reduce) { .animate-[kenBurns_6s_ease-out_forwards] { animation: none !important; } }`}</style>
    </div>
  );
}

function HeroSlide({ channel, active }: { channel: Channel; active: boolean }) {
  const isFavorite = useFavoritesStore((state) => state.ids.includes(channel.id));
  const toggle = useFavoritesStore((state) => state.toggle);
  const badge = channelBadge(channel.name);
  const programme = channel.nowPlaying;
  const [imgError, setImgError] = useState(false);
  useEffect(() => setImgError(false), [channel.id]);
  const rawBackdrop = (programme as unknown as { backdropUrl?: string | null; posterUrl?: string | null })?.backdropUrl ?? (programme as unknown as { posterUrl?: string | null })?.posterUrl ?? programme?.imageUrl ?? channel.logoUrl ?? null;
  const backdrop = rawBackdrop && !imgError ? rawBackdrop : null;
  const isLogoBackdrop = backdrop === channel.logoUrl;

  return (
    <div
      aria-hidden={!active}
      className={`absolute inset-0 transition-opacity duration-700 ${active ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
    >
      {backdrop ? (
        <img
          src={backdrop}
          alt=""
          onError={() => setImgError(true)}
          className={`h-full w-full object-cover ${isLogoBackdrop ? 'object-contain !h-[42%] !w-auto !max-w-[44%] !p-0 mx-auto my-auto !top-[44%] !left-1/2 !-translate-x-1/2 !-translate-y-1/2 absolute opacity-90 drop-shadow-[0_8px_32px_rgba(0,0,0,0.6)]' : active ? 'animate-[kenBurns_6s_ease-out_forwards]' : ''}`}
          loading={active ? 'eager' : 'lazy'}
          decoding="async"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#0f1419] via-surface to-bg">
          <span className="select-none text-[9rem] font-black leading-none text-white/[0.04] md:text-[13rem]">{channel.name.slice(0, 2).toUpperCase()}</span>
        </div>
      )}
      {isLogoBackdrop && <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/40 to-surface/20" />}

      <div className={`absolute inset-0 flex flex-col justify-end p-5 pb-[calc(84px+env(safe-area-inset-bottom))] md:justify-center md:p-0 md:pl-[4%] md:pr-[42%] md:pb-0 ${active ? '' : 'pointer-events-none'}`}>
        <div className="max-w-[640px]">
          <p className="mb-2 flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.18em] text-accent">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-sm bg-accent text-[10px] text-on-accent">N°1</span> En vedette aujourd'hui
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {badge && <span className="rounded-sm bg-white/15 px-1.5 py-0.5 text-[10px] font-black tracking-wide text-white backdrop-blur">{badge}</span>}
            {programme && (
              <span className="inline-flex items-center gap-1.5 rounded-sm bg-danger px-2 py-0.5 text-[10px] font-black tracking-widest text-white">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                DIRECT
              </span>
            )}
            <span className="text-xs font-semibold uppercase tracking-widest text-white/70">{channel.country ?? 'Live'} · {programme ? 'En cours' : 'Chaîne'}</span>
          </div>

          <h1 className="mt-3 line-clamp-2 text-[26px] font-black leading-[0.92] tracking-tight drop-shadow-[0_2px_16px_rgba(0,0,0,0.7)] sm:text-3xl md:text-[52px] md:leading-[0.9]">{programme?.title ?? channel.name}</h1>
          <p className="mt-2.5 line-clamp-2 text-[13px] leading-snug text-white/70 md:text-[15px] md:leading-relaxed">{programme ? `${channel.name} · ${new Date(programme.startsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} – ${new Date(programme.endsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · En direct` : 'Regardez en direct sur Mbolo TV — qualité adaptative, sans coupure.'}</p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Link
              href={`/watch/${channel.id}`}
              className="inline-flex items-center gap-2 rounded-md bg-white px-7 py-3 text-[15px] font-black text-black shadow-lg transition hover:bg-white/90"
            >
              <span className="text-lg leading-none">▶</span> Lecture
            </Link>
            <Link
              href={`/watch/${channel.id}`}
              className="inline-flex items-center gap-2 rounded-md bg-white/15 px-6 py-3 text-sm font-bold text-white backdrop-blur transition hover:bg-white/25"
            >
              Plus d'infos
            </Link>
            <span className="ml-1">
              <FavoriteButton
                label={isFavorite ? `Retirer ${channel.name} des favoris` : `Ajouter ${channel.name} aux favoris`}
                isActive={isFavorite}
                onToggle={() => toggle(channel.id)}
              />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
