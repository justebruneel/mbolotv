'use client';

import type { Channel, PlayResponse } from '@mbolo/contracts';
import { FavoriteButton, ProgrammeProgress, warmStream } from '@mbolo/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../../../shared/api/client';
import { useSettingsStore } from '../../../shared/stores/settings';
import { useFavoritesStore } from '../../../shared/stores/favorites';
import { channelBadge, channelInitials, buildWatchHref, type WatchContext } from '../utils';

export function ChannelTile({ channel, watchContext, highlight }: { channel: Channel; watchContext?: WatchContext; highlight?: boolean }) {
  const queryClient = useQueryClient();
  const isFavorite = useFavoritesStore((state) => state.ids.includes(channel.id));
  const toggle = useFavoritesStore((state) => state.toggle);
  const [logoError, setLogoError] = useState(false);
  const [thumbError, setThumbError] = useState(false);
  const href = buildWatchHref(channel.id, watchContext);
  const down = channel.healthStatus === 'DOWN';
  const isLive = channel.nowPlaying;
  const thumbUrl =
    (isLive as unknown as { backdropUrl?: string | null; posterUrl?: string | null })?.backdropUrl ??
    (isLive as unknown as { posterUrl?: string | null })?.posterUrl ??
    isLive?.imageUrl;

  const prefetch = (): void => {
    if (!down) {
      void queryClient.prefetchQuery({
        queryKey: ['channel', channel.id],
        queryFn: () => apiGet<Channel>(`/channels/${channel.id}`),
        staleTime: 30 * 60_000,
      });
      void queryClient
        .fetchQuery({
          queryKey: ['play', channel.id],
          queryFn: () =>
            apiGet<PlayResponse>(
              `/channels/${channel.id}/play`,
              useSettingsStore.getState().dataSaver ? { eco: 1 } : undefined,
            ),
          // Aligné sur usePlayUrl (même clé, même politique) pour que le
          // survol réchauffe réellement le cache utilisé par la page watch.
          staleTime: 60_000,
        })
        .then((data) => {
          if (data?.url) warmStream(data.url);
        });
    }
  };

  const badge = channelBadge(channel.name);

  const content = (
    <>
      {/* Background image */}
      <div className="absolute inset-0 z-0">
        {thumbUrl && !thumbError ? (
          <img
            src={thumbUrl}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setThumbError(true)}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
          />
        ) : channel.logoUrl && !logoError ? (
          <div className="absolute inset-0 flex items-center justify-center bg-surface">
            <img
              src={channel.logoUrl}
              alt=""
              width={112}
              height={80}
              loading="lazy"
              decoding="async"
              onError={() => setLogoError(true)}
              className="h-20 w-28 object-contain drop-shadow-sm"
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center bg-gradient-to-br from-surface-2 to-surface text-4xl font-bold text-muted/30">
            {channelInitials(channel.name)}
          </div>
        )}
        {/* Gradient renforcé : le nom de chaîne (sous la carte) doit rester l'élément dominant */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/35 to-transparent" />
      </div>

      {/* Top badges */}
      <div className="absolute left-2.5 top-2.5 z-10 flex items-center gap-1.5">
        {isLive && (
          <span className="inline-flex items-center gap-1 rounded-full bg-danger/90 px-2 py-0.5 text-[9px] font-bold tracking-wide text-white backdrop-blur-sm">
            <span className="h-1 w-1 animate-pulse rounded-full bg-white" />
            DIRECT
          </span>
        )}
        {badge && (
          <span className="rounded-md bg-accent/90 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-on-accent backdrop-blur-sm">
            {badge}
          </span>
        )}
      </div>

      {/* Favorite button */}
      <span
        className="absolute right-2 top-2 z-20"
        onClick={(event) => event.stopPropagation()}
      >
        <FavoriteButton
          label={isFavorite ? `Retirer ${channel.name} des favoris` : `Ajouter ${channel.name} aux favoris`}
          isActive={isFavorite}
          onToggle={() => toggle(channel.id)}
        />
      </span>

      {/* Bottom info */}
      <div className="absolute bottom-0 left-0 right-0 z-10 p-2.5">
        <div className="flex items-end gap-2">
          {/* Channel logo */}
          <div className="mb-1 flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-white shadow-sm">
            {channel.logoUrl && !logoError ? (
              <img
                src={channel.logoUrl}
                alt=""
                width={36}
                height={36}
                loading="lazy"
                decoding="async"
                onError={() => setLogoError(true)}
                className="h-full w-full object-contain p-1"
              />
            ) : (
              <span className="text-xs font-bold text-muted">{channelInitials(channel.name)}</span>
            )}
          </div>
          {/* Programme info : 1 ligne discrète + barre, pour ne pas concurrencer le nom de la chaîne */}
          <div className="min-w-0 flex-1">
            {isLive ? (
              <>
                <p className="truncate text-[11px] font-medium text-white/75">{isLive.title}</p>
                <ProgrammeProgress startsAt={isLive.startsAt} endsAt={isLive.endsAt} className="mt-0.5" showLabel={false} />
              </>
            ) : (
              <p className="truncate text-[11px] font-medium text-white/50">Pas de programme</p>
            )}
          </div>
        </div>
      </div>

      {/* Hover play button */}
      <div className="absolute inset-0 z-10 flex items-center justify-center opacity-0 transition-opacity duration-300 group-hover:opacity-100">
        {!down && (
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-on-accent shadow-lg transition-transform duration-200 group-hover:scale-110">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        )}
      </div>
    </>
  );

  return (
    <article
      className={`group relative min-w-0 ${down ? 'opacity-40 grayscale' : ''}`}
      onMouseEnter={prefetch}
    >
      <div className={`relative overflow-hidden rounded-xl border bg-surface transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-lg aspect-[4/3] sm:aspect-[16/10] ${highlight ? 'border-accent shadow-md shadow-accent/20' : 'border-border group-hover:border-accent/50'}`}>
        {down ? (
          <div aria-disabled="true" className="h-full">{content}</div>
        ) : (
          <Link
            href={href}
            aria-label={`Regarder ${channel.name}`}
            className="block h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
          >
            {content}
          </Link>
        )}
      </div>

      {/* Channel name below card */}
      <div className="mt-2 px-0.5">
        <p className="line-clamp-2 text-[13px] font-semibold leading-tight text-foreground transition-colors duration-200 group-hover:text-accent">
          {channel.name}
        </p>
        {channel.country && (
          <p className="mt-0.5 truncate text-[11px] text-muted">{channel.country}</p>
        )}
      </div>
    </article>
  );
}
