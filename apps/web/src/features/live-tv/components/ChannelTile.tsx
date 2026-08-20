'use client';

import type { Channel } from '@mbolo/contracts';
import { FavoriteButton } from '@mbolo/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../../../shared/api/client';
import { useFavoritesStore } from '../../../shared/stores/favorites';
import { channelBadge, channelInitials, buildWatchHref, type WatchContext } from '../utils';

export function ChannelTile({ channel, watchContext }: { channel: Channel; watchContext?: WatchContext }) {
  const queryClient = useQueryClient();
  const isFavorite = useFavoritesStore((state) => state.ids.includes(channel.id));
  const toggle = useFavoritesStore((state) => state.toggle);
  const [logoError, setLogoError] = useState(false);
  const href = buildWatchHref(channel.id, watchContext);
  const down = channel.healthStatus === 'DOWN';
  const isLive = channel.nowPlaying;

  const prefetch = (): void => {
    if (!down) {
      void queryClient.prefetchQuery({
        queryKey: ['channel', channel.id],
        queryFn: () => apiGet<Channel>(`/channels/${channel.id}`),
        staleTime: 30 * 60_000,
      });
    }
  };

  const logo = (
    <span className="flex h-22 w-22 items-center justify-center overflow-hidden rounded-2xl bg-surface-2 text-2xl font-bold text-muted transition-transform duration-300 group-hover:scale-105">
      {channel.logoUrl && !logoError ? (
        <img
          src={channel.logoUrl}
          alt=""
          width={96}
          height={96}
          loading="lazy"
          decoding="async"
          onError={() => setLogoError(true)}
          className="h-full w-full object-contain p-3"
        />
      ) : (
        channelInitials(channel.name)
      )}
    </span>
  );

  const liveIndicator = isLive && (
    <span className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-danger/90 px-2.5 py-1 text-[10px] font-bold tracking-wide text-white backdrop-blur-sm">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
      DIRECT
    </span>
  );

  const badge = channelBadge(channel.name) && (
    <span className="absolute left-3 top-3 rounded-lg bg-accent/90 px-2 py-1 text-[10px] font-bold tracking-wide text-on-accent backdrop-blur-sm">
      {channelBadge(channel.name)}
    </span>
  );

  return (
    <article
      className={`group relative min-w-0 ${down ? 'opacity-40 grayscale' : ''}`}
      onMouseEnter={prefetch}
    >
      <div className="relative aspect-square overflow-hidden rounded-2xl border border-border bg-surface-3 transition-all duration-300 group-hover:-translate-y-1 group-hover:border-accent/50 group-hover:shadow-lg">
        {down ? (
          <div aria-disabled="true">{logo}{liveIndicator}{badge}</div>
        ) : (
          <Link
            href={href}
            aria-label={`Regarder ${channel.name}`}
            className="block h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
          >
            {logo}{liveIndicator}{badge}
          </Link>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 z-0 flex items-center justify-center bg-gradient-to-t from-black/60 via-black/20 to-transparent opacity-0 pointer-events-none transition-opacity duration-300 group-hover:opacity-100 group-hover:pointer-events-auto">
          {!down && (
            <Link
              href={href}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-on-accent shadow-lg transition-transform duration-200 hover:scale-110"
              aria-label={`Lancer ${channel.name}`}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </Link>
          )}
        </div>

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
      </div>

      <Link href={href} className="mt-2.5 block truncate text-sm font-semibold text-foreground transition-colors duration-200 hover:text-accent">
        {channel.name}
      </Link>
      {channel.country && (
        <p className="mt-0.5 truncate text-xs text-muted">{channel.country}</p>
      )}
    </article>
  );
}
