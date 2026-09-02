'use client';

import type { Match } from '@mbolo/contracts';
import { Icon } from '@mbolo/ui';
import Link from 'next/link';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../../shared/api/client';
import type { MatchListResponse } from '@mbolo/contracts';

/**
 * Section « À la une · Football » : prochains matchs des grandes compétitions
 * européennes (agenda TheSportsDB, sync cron 6 h) appariés aux chaînes de
 * l'EPG pour afficher la diffusion. Source gratuite — si l'API est indisponible
 * ou qu'aucun match n'est programmé, la section disparaît silencieusement.
 */

// Priorité de tri (la Champions League et les grands championnats d'abord).
const COMPETITION_PRIORITY: Array<{ token: string; priority: number }> = [
  { token: 'champions league', priority: 1 },
  { token: 'premier league', priority: 2 },
  { token: 'la liga', priority: 3 },
  { token: 'ligue 1', priority: 4 },
  { token: 'serie a', priority: 5 },
  { token: 'bundesliga', priority: 6 },
];

const MAX_ITEMS = 12;

function competitionPriority(competition: string): number {
  const lower = competition.toLowerCase();
  for (const { token, priority } of COMPETITION_PRIORITY) {
    if (lower.includes(token)) return priority;
  }
  return 99;
}

export function FootballFeatured() {
  const query = useQuery({
    queryKey: ['matches', 'football-featured'],
    queryFn: () =>
      apiGet<MatchListResponse>('/matches', {
        sport: 'Football',
        state: 'SCHEDULED',
        from: new Date().toISOString(),
        to: new Date(Date.now() + 48 * 3_600_000).toISOString(),
      }),
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });

  const items = useMemo(() => {
    const matches = (query.data?.items ?? []).filter((match) => match.channels.length > 0 || match.homeTeamLogo);
    return matches
      .sort((a, b) => competitionPriority(a.competition) - competitionPriority(b.competition) || new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
      .slice(0, MAX_ITEMS);
  }, [query.data]);

  if (query.isLoading || items.length === 0) return null;

  return (
    <section className="group/row relative">
      <h2 className="mb-2.5 flex items-center gap-2 px-4 text-base font-bold text-foreground md:px-10 md:text-lg">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <Icon.Trophy size={14} aria-hidden />
        </span>
        À la une · Football
        <span className="ml-1 text-xs font-semibold text-muted">prochains grands matchs</span>
      </h2>
      <div className="flex snap-x gap-3 overflow-x-auto px-4 pb-4 md:gap-4 md:px-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((match) => (
          <FeaturedMatchCard key={match.id} match={match} />
        ))}
      </div>
    </section>
  );
}

function FeaturedMatchCard({ match }: { match: Match }) {
  const startsAt = new Date(match.startsAt);
  const dayLabel = startsAt.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  const timeLabel = startsAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const channel = match.channels[0];
  return (
    <div className="w-64 shrink-0 snap-start rounded-2xl border border-border bg-surface p-4 transition hover:shadow-md">
      <p className="truncate text-[10px] font-black uppercase tracking-widest text-accent">{match.competition}</p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <TeamBadge name={match.homeTeam} logo={match.homeTeamLogo} />
        <span className="text-xs font-black text-muted">VS</span>
        <TeamBadge name={match.awayTeam} logo={match.awayTeamLogo} align="right" />
      </div>
      <p className="mt-3 text-center text-xs font-semibold text-muted">
        {dayLabel} · {timeLabel}
      </p>
      {channel && (
        <Link
          href={`/watch/${channel.id}`}
          className="mt-3 flex items-center justify-center gap-2 rounded-xl bg-accent px-3 py-2 text-xs font-bold text-on-accent transition hover:bg-accent-hover"
        >
          <Icon.Tv size={13} aria-hidden />
          <span className="truncate max-w-[10rem]">Sur {channel.name}</span>
        </Link>
      )}
      {!channel && <p className="mt-3 text-center text-[11px] text-muted">Chaîne non détectée dans l'EPG</p>}
    </div>
  );
}

function TeamBadge({ name, logo, align = 'left' }: { name: string; logo?: string | null; align?: 'left' | 'right' }) {
  return (
    <div className={`flex min-w-0 flex-1 flex-col items-center gap-1.5 ${align === 'right' ? 'text-right' : ''}`}>
      {logo ? (
        <img src={logo} alt="" loading="lazy" className="h-9 w-9 object-contain" />
      ) : (
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-accent/10 text-xs font-black text-accent">
          {name.slice(0, 2).toUpperCase()}
        </span>
      )}
      <span className="line-clamp-2 text-center text-xs font-bold leading-tight text-foreground">{name}</span>
    </div>
  );
}
