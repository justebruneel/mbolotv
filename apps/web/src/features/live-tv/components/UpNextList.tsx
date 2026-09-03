'use client';

import type { Channel } from '@mbolo/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { ProgrammeProgress } from '@mbolo/ui';
import { buildWatchHref, channelBadge, channelInitials, channelMonogramStyle, type WatchContext } from '../utils';
import { ChevronRightIcon } from './Icons';

function programmeThumb(channel: Channel): string | null {
  const programme = channel.nowPlaying;
  if (!programme) return null;
  const enriched = programme as unknown as { backdropUrl?: string | null; posterUrl?: string | null };
  return enriched.backdropUrl ?? enriched.posterUrl ?? programme.imageUrl ?? null;
}

/** File « À suivre » façon YouTube : colonne verticale de cartes compactes
 * affichée à droite du lecteur sur desktop — zap en un clic sans quitter la
 * page. Sur mobile et en mode théâtre, la rangée Similaires la remplace. */
export function UpNextList({
  title,
  channels,
  context,
  seeAllHref,
  collapsedTo,
}: {
  title: string;
  channels: Channel[];
  /** Contexte (dossier/pays/recherche) conservé par les liens de zap. */
  context?: WatchContext;
  seeAllHref?: string;
  /** Mobile : liste repliée sur les N premières chaînes, bouton « Tout afficher ». */
  collapsedTo?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded || collapsedTo === undefined ? channels : channels.slice(0, collapsedTo);
  return (
    <div className="py-1">
      <div className="flex items-end justify-between gap-2 px-1 pb-2">
        <h2 className="text-sm font-bold text-foreground">
          {title}
          <span className="ml-1.5 text-xs font-normal text-muted">{channels.length}</span>
        </h2>
        {seeAllHref && (
          <Link href={seeAllHref} className="flex shrink-0 items-center gap-0.5 text-xs font-semibold text-muted transition-colors hover:text-accent">
            Tout voir <ChevronRightIcon size={13} />
          </Link>
        )}
      </div>

      <div className="flex flex-col gap-1">
        {visible.map((channel) => (
          <UpNextCard key={channel.id} channel={channel} context={context} />
        ))}
      </div>

      {collapsedTo !== undefined && channels.length > collapsedTo && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="mt-1 w-full rounded-xl border border-border bg-surface py-2.5 text-xs font-bold text-muted transition hover:bg-surface-2 hover:text-foreground"
        >
          {expanded ? 'Réduire' : `Tout afficher (${channels.length})`}
        </button>
      )}
    </div>
  );
}

function UpNextCard({ channel, context }: { channel: Channel; context?: WatchContext }) {
  const programme = channel.nowPlaying;
  const thumb = programmeThumb(channel);
  const badge = channelBadge(channel.name);
  const down = channel.healthStatus === 'DOWN';
  const [logoError, setLogoError] = useState(false);

  return (
    <Link
      href={buildWatchHref(channel.id, context)}
      aria-label={`Regarder ${channel.name}`}
      className={`group flex gap-3 rounded-xl p-1.5 transition-colors hover:bg-surface-2 ${down ? 'opacity-50' : ''}`}
    >
      <div className="relative aspect-video w-[148px] shrink-0 overflow-hidden rounded-lg border border-border/60 bg-surface">
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-surface-3 to-surface">
            {channel.logoUrl && !logoError ? (
              <img src={channel.logoUrl} alt="" loading="lazy" decoding="async" onError={() => setLogoError(true)} className="max-h-[55%] max-w-[65%] object-contain drop-shadow-md" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-2xl font-black text-white/85" style={channelMonogramStyle(channel.name)}>{channelInitials(channel.name)}</span>
            )}
          </div>
        )}

        {badge && (
          <span className="absolute right-1 top-1 rounded bg-black/70 px-1 py-px text-[8px] font-black tracking-wide text-white">{badge}</span>
        )}

        {programme && (
          <span className="absolute left-1 top-1 inline-flex items-center gap-1 rounded-full bg-danger px-1 py-px text-[8px] font-black tracking-widest text-white">
            <span className="h-1 w-1 rounded-full bg-white" />
            DIRECT
          </span>
        )}

        {programme && (
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/40">
            <ProgrammeProgress startsAt={programme.startsAt} endsAt={programme.endsAt} showLabel={false} />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 py-0.5">
        <p className="truncate text-[13px] font-bold text-foreground/90">{channel.name}</p>
        {programme ? (
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted">
            {programme.title} · fin {new Date(programme.endsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
          </p>
        ) : (
          <p className="mt-0.5 truncate text-[11px] text-muted">{channel.country ?? 'Live'}</p>
        )}
      </div>
    </Link>
  );
}
