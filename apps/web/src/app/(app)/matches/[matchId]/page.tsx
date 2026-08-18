'use client';

import { Badge, EmptyState, Icon, Player, Spinner } from '@mbolo/ui';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useMatch, useMatchPlay } from '../../../../shared/api/queries';
import { PageHeader } from '../../../../shared/components/PageHeader';
import { useSettingsStore } from '../../../../shared/stores/settings';

const STATE_LABEL: Record<string, string> = { LIVE: 'En direct', SCHEDULED: 'À venir', FINISHED: 'Terminé', POSTPONED: 'Reporté' };

export default function MatchWatchPage() {
  const params = useParams<{ matchId: string }>();
  const router = useRouter();
  const matchId = params.matchId;
  const [channelId, setChannelId] = useState<string | undefined>(undefined);
  const volume = useSettingsStore((state) => state.volume);
  const preferredLevel = useSettingsStore((state) => state.preferredLevel);
  const dataSaver = useSettingsStore((state) => state.dataSaver);
  const setVolume = useSettingsStore((state) => state.setVolume);
  const setPreferredLevel = useSettingsStore((state) => state.setPreferredLevel);
  const setDataSaver = useSettingsStore((state) => state.setDataSaver);
  const matchQuery = useMatch(matchId, 30_000);
  const playQuery = useMatchPlay(matchId, channelId);
  const playUrls = useMemo(() => (playQuery.data?.url ? [playQuery.data.url] : []), [playQuery.data?.url]);
  const goBack = (): void => { if (window.history.length > 1) router.back(); else router.replace('/matches'); };
  if (matchQuery.isLoading || !matchQuery.data) return <div className="flex justify-center p-12"><Spinner /></div>;
  const match = matchQuery.data;
  const startsAt = new Date(match.startsAt);
  return (
    <>
      <button type="button" onClick={goBack} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-accent"><Icon.ChevronLeft size={15} aria-hidden /> Retour</button>
      <PageHeader
        title={<span className="flex items-center gap-2">{match.homeTeam} – {match.awayTeam}<Badge tone={match.state === 'LIVE' ? 'danger' : 'accent'} live={match.state === 'LIVE'}>{STATE_LABEL[match.state]}</Badge></span>}
        description={`${match.competition || match.sport} · ${startsAt.toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`}
      />
      {playQuery.isLoading ? (
        <div className="aspect-video flex items-center justify-center rounded-2xl bg-black"><Spinner /></div>
      ) : playUrls.length > 0 ? (
        <Player urls={playUrls} title={`${match.homeTeam} – ${match.awayTeam}`} initialVolume={volume} initialLevel={preferredLevel} initialDataSaver={dataSaver} onVolumeChange={setVolume} onLevelChange={setPreferredLevel} onDataSaverChange={setDataSaver} />
      ) : (
        <EmptyState title="Lecture indisponible" hint="Aucun flux n'est disponible pour ce match pour le moment." />
      )}
      {match.channels.length > 0 && (
        <div className="mt-5"><h2 className="mb-3 text-sm font-semibold text-muted">Chaînes de diffusion</h2><div className="flex flex-wrap gap-2">{match.channels.map((channel) => <button key={channel.id} type="button" onClick={() => setChannelId(channel.id)} className={channelId === channel.id ? 'rounded-full border border-primary bg-primary px-3.5 py-2 text-sm font-semibold text-on-primary' : 'rounded-full border border-border bg-surface px-3.5 py-2 text-sm font-semibold text-muted transition-colors hover:border-accent/60 hover:text-foreground'}>{channel.name}{channel.streamCount > 1 && <span className="opacity-70"> · {channel.streamCount} flux</span>}</button>)}</div>{match.channels.length > 1 && <p className="mt-2 text-xs text-muted">Si le flux rame, bascule sur une autre chaîne : elle propose généralement le même match.</p>}</div>
      )}
    </>
  );
}
