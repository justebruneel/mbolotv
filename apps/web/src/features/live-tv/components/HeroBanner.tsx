'use client';

import type { Channel } from '@mbolo/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { FavoriteButton } from '@mbolo/ui';
import { useFavoritesStore } from '../../../shared/stores/favorites';
import { channelBadge } from '../utils';

const ROTATE_MS = 8_000;

// Hero Netflix-style : rotation automatique des chaînes en vedette,
// fond = visuel du programme en cours (repli : dégradé + logo).
export function HeroBanner({ channels }: { channels: Channel[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (channels.length <= 1 || paused) {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) setPaused(true);
      return;
    }
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % channels.length), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [channels.length, paused]);

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
      className="relative h-[62vh] min-h-[400px] w-full overflow-hidden"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {channels.map((channel, position) => (
        <HeroSlide key={channel.id} channel={channel} active={position === index} />
      ))}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-bg to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 left-0 w-full bg-gradient-to-r from-bg/90 via-bg/30 to-transparent" />

      <div className="absolute bottom-24 right-6 z-20 hidden flex-col items-end gap-2 md:flex">
        {channels.map((channel, position) => (
          <button
            key={channel.id}
            type="button"
            aria-label={`Mettre en avant ${channel.name}`}
            onClick={() => setIndex(position)}
            className={`h-1 rounded-full transition-all duration-300 ${position === index ? 'w-8 bg-accent' : 'w-4 bg-white/30 hover:bg-white/60'}`}
          />
        ))}
      </div>
    </div>
  );
}

function HeroSlide({ channel, active }: { channel: Channel; active: boolean }) {
  const isFavorite = useFavoritesStore((state) => state.ids.includes(channel.id));
  const toggle = useFavoritesStore((state) => state.toggle);
  const badge = channelBadge(channel.name);
  const programme = channel.nowPlaying;
  const backdrop = programme?.imageUrl ?? null;

  return (
    <div
      aria-hidden={!active}
      className={`absolute inset-0 transition-opacity duration-700 ${active ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
    >
      {backdrop ? (
        <img src={backdrop} alt="" className="h-full w-full object-cover" loading={active ? 'eager' : 'lazy'} decoding="async" />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-surface-3 via-surface to-bg">
          <span className="select-none text-[9rem] font-black leading-none text-white/5">{channel.name.slice(0, 2).toUpperCase()}</span>
        </div>
      )}

      <div className={`absolute inset-x-0 bottom-0 p-6 md:p-16 ${active ? '' : 'pointer-events-none'}`}>
        <div className="max-w-xl">
          <div className="flex flex-wrap items-center gap-2">
            {badge && <span className="rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-black tracking-wide text-on-accent">{badge}</span>}
            {programme && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-danger px-2 py-0.5 text-[10px] font-black tracking-widest text-white">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                DIRECT
              </span>
            )}
            <span className="text-xs font-semibold uppercase tracking-widest text-white/70">{channel.country ?? 'Live'}</span>
          </div>

          <h1 className="mt-3 line-clamp-2 text-3xl font-black leading-tight drop-shadow-lg md:text-5xl">{programme?.title ?? channel.name}</h1>
          <p className="mt-2 text-sm font-semibold text-white/80">{channel.name}</p>
          {programme && (
            <p className="mt-1 text-xs text-white/60">
              {new Date(programme.startsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
              {' – '}
              {new Date(programme.endsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
            </p>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Link href={`/watch/${channel.id}`} className="btn btn-primary !px-7 !py-3 !text-base shadow-lg">
              ▶ Regarder
            </Link>
            <FavoriteButton
              label={isFavorite ? `Retirer ${channel.name} des favoris` : `Ajouter ${channel.name} des favoris`}
              isActive={isFavorite}
              onToggle={() => toggle(channel.id)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
