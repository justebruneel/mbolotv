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
  const has = useFavoritesStore((state) => state.has);
  const toggle = useFavoritesStore((state) => state.toggle);
  const [logoError, setLogoError] = useState(false);
  const href = buildWatchHref(channel.id, watchContext);
  const down = channel.healthStatus === 'DOWN';
  const prefetch = (): void => { if (!down) void queryClient.prefetchQuery({ queryKey: ['channel', channel.id], queryFn: () => apiGet<Channel>(`/channels/${channel.id}`), staleTime: 30 * 60_000 }); };
  const visual = <><div className="flex h-full w-full items-center justify-center p-4"><span className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl bg-surface-2 text-2xl font-bold text-muted">{channel.logoUrl && !logoError ? <img src={channel.logoUrl} alt="" width={96} height={96} loading="lazy" decoding="async" onError={() => setLogoError(true)} className="h-full w-full object-contain p-3" /> : channelInitials(channel.name)}</span></div>{channel.nowPlaying && <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-bg px-2 py-1 text-[10px] font-bold text-danger"><span className="h-1.5 w-1.5 rounded-full bg-danger" />DIRECT</span>}{channelBadge(channel.name) && <span className="absolute left-2 top-2 rounded bg-accent px-1.5 py-1 text-[10px] font-bold text-on-accent">{channelBadge(channel.name)}</span>}</>;
  return <article className={`group relative min-w-0 ${down ? 'opacity-50 grayscale' : ''}`} onMouseEnter={prefetch}><div className="relative aspect-square overflow-hidden rounded-2xl border border-border bg-surface-3 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:border-accent/60">{down ? <div aria-disabled="true">{visual}</div> : <Link href={href} aria-label={`Regarder ${channel.name}`} className="block h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset">{visual}</Link>}<span className="absolute right-2 top-2 z-10" onClick={(event) => event.stopPropagation()}><FavoriteButton label={has(channel.id) ? `Retirer ${channel.name} des favoris` : `Ajouter ${channel.name} aux favoris`} isActive={has(channel.id)} onToggle={() => toggle(channel.id)} /></span></div><Link href={href} className="mt-2 block truncate text-sm font-semibold text-foreground hover:text-accent">{channel.name}</Link>{channel.country && <p className="mt-0.5 truncate text-xs text-muted">{channel.country}</p>}</article>;
}
