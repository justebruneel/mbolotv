'use client';

import type { Channel } from '@mbolo/contracts';
import { FavoriteButton } from '@mbolo/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../../../shared/api/client';
import { useFavoritesStore } from '../../../shared/stores/favorites';
import { channelBadge, channelInitials, buildWatchHref, type WatchContext } from '../utils';

export function ChannelTile({
  channel,
  watchContext,
}: {
  channel: Channel;
  watchContext?: WatchContext;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const has = useFavoritesStore((state) => state.has);
  const toggle = useFavoritesStore((state) => state.toggle);
  const [logoError, setLogoError] = useState(false);

  const badge = channelBadge(channel.name);
  const live = channel.nowPlaying != null;
  const down = channel.healthStatus === 'DOWN';

  const open = (): void => {
    if (down) return;
    router.push(buildWatchHref(channel.id, watchContext));
  };

  const prefetch = (): void => {
    if (down) return;
    void queryClient.prefetchQuery({
      queryKey: ['channel', channel.id],
      queryFn: () => apiGet<Channel>(`/channels/${channel.id}`),
      staleTime: 30 * 60_000,
    });
  };

  const tileClass = down
    ? 'relative aspect-square rounded-xl bg-surface-2 border border-border overflow-hidden flex items-center justify-center opacity-50 grayscale cursor-not-allowed'
    : 'relative aspect-square rounded-xl bg-surface-3 border border-border overflow-hidden flex items-center justify-center transition-colors group-hover:border-accent/60 cursor-pointer';

  return (
    <div
      role="button"
      tabIndex={down ? -1 : 0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter') open();
      }}
      onMouseEnter={prefetch}
      className="group relative w-32 shrink-0 outline-none"
      aria-disabled={down}
    >
      <div className={tileClass}>
        {channel.logoUrl != null && !logoError ? (
          <img
            src={channel.logoUrl}
            alt=""
            width={72}
            height={72}
            loading="lazy"
            decoding="async"
            onError={() => setLogoError(true)}
            className="object-contain p-2"
          />
        ) : (
          <span className="text-2xl font-bold text-muted transition-colors group-hover:text-accent">
            {channelInitials(channel.name)}
          </span>
        )}

        {badge && (
          <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-accent text-on-accent leading-none">
            {badge}
          </span>
        )}

        {down ? (
          <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded-full bg-bg/80 text-[10px] font-semibold text-muted leading-none">
            Hors ligne
          </span>
        ) : (
          live && (
            <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-bg/80 text-[10px] font-semibold text-danger leading-none">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-danger opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-danger" />
              </span>
              DIRECT
            </span>
          )
        )}

        <span
          className="absolute top-1 right-1 z-10 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <FavoriteButton isActive={has(channel.id)} onToggle={() => toggle(channel.id)} />
        </span>
      </div>

      <p className="mt-1.5 text-sm font-medium text-foreground truncate">{channel.name}</p>
      {channel.country && <p className="text-xs text-muted truncate">{channel.country}</p>}
    </div>
  );
}
