'use client';

import type { Channel } from '@mbolo/contracts';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { FavoriteButton, ProgrammeProgress, Skeleton } from '@mbolo/ui';
import { useFavoritesStore } from '../../../shared/stores/favorites';
import { useChannelRow } from '../../../shared/api/queries';
import { channelBadge, channelInitials } from '../utils';
import { ChevronRightIcon } from './Icons';
import { Icon } from '@mbolo/ui';

const PAGE_LIMIT = 24;

function useInView(rootMargin = '400px') {
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (inView || !ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [inView, rootMargin]);
  return { ref, inView };
}

export function NetflixRow({
  title,
  subtitle,
  slug,
  channels: directChannels,
  seeAllHref,
}: {
  title: string;
  subtitle?: string;
  /** Slug de catégorie : la rangée charge ses chaînes elle-même (lazy). */
  slug?: string;
  /** Chaînes fournies directement (sans fetch). */
  channels?: Channel[];
  seeAllHref?: string;
}) {
  const { ref, inView } = useInView();
  const enabled = Boolean(inView && (slug || directChannels));
  const rowQuery = useChannelRow(slug, PAGE_LIMIT, enabled && !directChannels);
  const channels = directChannels ?? rowQuery.data?.items ?? [];
  const isLoading = enabled && !directChannels && rowQuery.isLoading;

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const scrollRafRef = useRef(0);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  function updateArrows(): void {
    const el = scrollerRef.current;
    if (!el) return;
    const nextStart = el.scrollLeft <= 8;
    const nextEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8;
    // Bail-out : sans changement on ne re-rend pas (le swipe re-déclenche
    // l'événement scroll à chaque pixel — re-render = saccades).
    setAtStart((prev) => (prev === nextStart ? prev : nextStart));
    setAtEnd((prev) => (prev === nextEnd ? prev : nextEnd));
  }

  function scheduleArrows(): void {
    cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(updateArrows);
  }

  useEffect(() => () => cancelAnimationFrame(scrollRafRef.current), []);

  function scrollByPage(direction: -1 | 1): void {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.9, behavior: 'smooth' });
  }

  return (
    <section ref={ref} className="group/row relative">
      <div className="mb-2.5 flex items-end justify-between gap-3 px-4 md:px-10">
        <div>
          <h2 className="text-base font-bold text-foreground md:text-lg">
            {title}
            {subtitle !== undefined && <span className="ml-2 text-sm font-normal text-muted">{subtitle}</span>}
          </h2>
        </div>
        {seeAllHref && (
          <Link href={seeAllHref} className="flex shrink-0 items-center gap-1 text-xs font-semibold text-muted transition-colors hover:text-accent">
            Tout parcourir <ChevronRightIcon size={14} />
          </Link>
        )}
      </div>

      <div className="relative">
        {/* Fondus de bord */}
        {!atStart && <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-bg to-transparent md:w-16" />}
        {!atEnd && <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-bg to-transparent md:w-16" />}

        {/* Flèches de navigation (desktop, au survol de la rangée) */}
        {!atStart && (
          <button
            type="button"
            aria-label="Précédent"
            onClick={() => scrollByPage(-1)}
            className="absolute left-1 top-1/2 z-20 hidden h-16 w-10 -translate-y-1/2 items-center justify-center rounded-xl border border-border bg-bg/80 text-foreground opacity-0 backdrop-blur transition-opacity hover:bg-surface-3 group-hover/row:opacity-100 md:flex"
          >
            <Icon.ChevronLeft size={26} />
          </button>
        )}
        {!atEnd && (
          <button
            type="button"
            aria-label="Suivant"
            onClick={() => scrollByPage(1)}
            className="absolute right-1 top-1/2 z-20 hidden h-16 w-10 -translate-y-1/2 items-center justify-center rounded-xl border border-border bg-bg/80 text-foreground opacity-0 backdrop-blur transition-opacity hover:bg-surface-3 group-hover/row:opacity-100 md:flex"
          >
            <Icon.ChevronRight size={26} />
          </button>
        )}

        <div
          ref={(element) => {
            scrollerRef.current = element;
            updateArrows();
          }}
          onScroll={scheduleArrows}
          className="flex snap-x gap-3 overflow-x-auto px-4 pb-6 pt-2 md:gap-4 md:px-10 [scroll-snap-type:x_proximity] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {isLoading
            ? Array.from({ length: 7 }).map((_, index) => (
                <div key={index} className="shrink-0 snap-start">
                  <Skeleton width={248} height={140} className="rounded-xl" />
                </div>
              ))
            : channels.map((channel) => (
                <RowCard key={channel.id} channel={channel} />
              ))}
          {!isLoading && channels.length === 0 && <p className="py-8 text-sm text-muted">Aucune chaîne.</p>}
        </div>
      </div>
    </section>
  );
}

function RowCard({ channel }: { channel: Channel }) {
  const isFavorite = useFavoritesStore((state) => state.ids.includes(channel.id));
  const toggle = useFavoritesStore((state) => state.toggle);
  const badge = channelBadge(channel.name);
  const programme = channel.nowPlaying;
  const thumb =
    (programme as unknown as { backdropUrl?: string | null; posterUrl?: string | null })?.backdropUrl ??
    (programme as unknown as { posterUrl?: string | null })?.posterUrl ??
    programme?.imageUrl ??
    null;
  const down = channel.healthStatus === 'DOWN';

  return (
    <article className={`shrink-0 snap-start ${down ? 'opacity-50' : ''}`}>
      <Link
        href={`/watch/${channel.id}`}
        aria-label={`Regarder ${channel.name}`}
        className="group/card relative block w-[44vw] max-w-[248px] shrink-0 overflow-hidden rounded-xl border border-border/60 bg-surface transition-all duration-300 hover:z-30 hover:scale-[1.05] hover:border-accent/70 hover:shadow-2xl md:w-[264px] md:max-w-none md:hover:scale-[1.07]"
      >
        {/* Visuel : vignette du programme en cours, sinon logo sur dégradé */}
        <div className="relative aspect-video w-full">
          {thumb ? (
            <img src={thumb} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-surface-3 to-surface">
              {channel.logoUrl ? (
                    <img src={channel.logoUrl} alt="" loading="lazy" decoding="async" className="max-h-[55%] max-w-[65%] object-contain drop-shadow-md" />
              ) : (
                <span className="text-3xl font-black text-white/10">{channelInitials(channel.name)}</span>
              )}
            </div>
          )}

          {/* Badge qualité */}
          {badge && (
            <span className="absolute right-1.5 top-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[9px] font-black tracking-wide text-white backdrop-blur-sm">{badge}</span>
          )}

          {/* DIRECT */}
          {programme && (
            <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-danger/90 px-1.5 py-0.5 text-[9px] font-black tracking-widest text-white">
              <span className="h-1 w-1 animate-pulse rounded-full bg-white" />
              DIRECT
            </span>
          )}

          {/* Favori au survol */}
          {!down && (
            <span
              className="absolute bottom-8 right-1.5 z-10 opacity-100 transition-opacity md:opacity-0 md:group-hover/card:opacity-100"
              onClick={(event) => event.preventDefault()}
            >
              <FavoriteButton
                label={isFavorite ? `Retirer ${channel.name} des favoris` : `Ajouter ${channel.name} aux favoris`}
                isActive={isFavorite}
                onToggle={() => toggle(channel.id)}
              />
            </span>
          )}

          {/* Bandeau info au survol */}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-2 pt-6 opacity-0 transition-opacity duration-200 group-hover/card:opacity-100">
            <p className="truncate text-xs font-bold text-white">{programme?.title ?? channel.name}</p>
            {programme && (
              <p className="mt-0.5 flex items-center justify-between text-[10px] text-white/70">
                <span>{channel.name}</span>
                <span>{new Date(programme.endsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
              </p>
            )}
          </div>

          {/* Progression du programme en cours */}
          {programme && (
            <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/40 opacity-100 group-hover/card:opacity-0">
              <ProgrammeProgress startsAt={programme.startsAt} endsAt={programme.endsAt} />
            </div>
          )}
        </div>

        <div className="min-w-0 px-2.5 py-2">
          <p className="truncate text-xs font-bold text-foreground/90">{programme?.title ?? channel.name}</p>
          <p className="mt-0.5 truncate text-[10px] font-medium uppercase tracking-wide text-muted">
            {programme ? `${channel.name} · fin ${new Date(programme.endsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : channel.country ?? ''}
          </p>
        </div>
      </Link>
    </article>
  );
}
