'use client';

import { Badge, Button, EmptyState, Icon, Player, Spinner } from '@mbolo/ui';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useChannel, useChannelEpg, useChannelViewers, useInfiniteChannels, usePlayUrl, useActivityHeartbeat } from '../../../../shared/api/queries';
import { FavoriteToggle } from '../../../../shared/components/FavoriteToggle';
import { useSettingsStore } from '../../../../shared/stores/settings';
import { buildWatchHref } from '../../../../features/live-tv/utils';
import { NetflixRow } from '../../../../features/live-tv/components/NetflixRow';

const PAGE_SIZE = 48;

function categoryRowTitle(category?: string): string {
  if (!category) return 'Chaînes similaires';
  const parts = category.split('|').map((part) => part.trim()).filter(Boolean);
  const label = parts[parts.length - 1] ?? category;
  return `Similaires · ${label}`;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function ProgrammeProgressInline({ startsAt, endsAt }: { startsAt: string; endsAt: string }) {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  const pct = Math.min(100, Math.max(0, ((Date.now() - start) / Math.max(1, end - start)) * 100));
  return (
    <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} />
  );
}

export default function WatchPage() {
  const params = useParams<{ channelId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const channelId = params.channelId;
  const category = searchParams.get('category') ?? undefined;
  const country = searchParams.get('country') ?? undefined;
  const q = searchParams.get('q') ?? undefined;
  const volume = useSettingsStore((state) => state.volume);
  const preferredLevel = useSettingsStore((state) => state.preferredLevel);
  const dataSaver = useSettingsStore((state) => state.dataSaver);
  const setVolume = useSettingsStore((state) => state.setVolume);
  const setPreferredLevel = useSettingsStore((state) => state.setPreferredLevel);
  const setDataSaver = useSettingsStore((state) => state.setDataSaver);
  const recordWatch = useSettingsStore((state) => state.recordWatch);
  const lastNonWatchPath = useSettingsStore((state) => state.lastNonWatchPath);
  const setLastWatchedChannelId = useSettingsStore((state) => state.setLastWatchedChannelId);
  const channelQuery = useChannel(channelId);
  const epgQuery = useChannelEpg(channelId);
  const playQuery = usePlayUrl(channelId);
  const channelsQuery = useInfiniteChannels({ category, country, q }, PAGE_SIZE);
  const navChannels = channelsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const viewersQuery = useChannelViewers(channelId);
  useActivityHeartbeat(channelId);
  const playUrls = useMemo(() => (playQuery.data?.url ? [playQuery.data.url] : []), [playQuery.data?.url]);

  // Chrome du player : visible au survol desktop, permanent sur tactile.
  const [chromeVisible, setChromeVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (window.matchMedia('(hover: none)').matches) {
      setChromeVisible(true);
      return;
    }
    const show = () => {
      setChromeVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setChromeVisible(false), 3000);
    };
    show();
    window.addEventListener('mousemove', show);
    return () => {
      window.removeEventListener('mousemove', show);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  useEffect(() => {
    setLastWatchedChannelId(channelId);
    return () => setLastWatchedChannelId(null);
  }, [channelId, setLastWatchedChannelId]);

  useEffect(() => {
    if (channelQuery.data) recordWatch(channelId, channelQuery.data.name);
  }, [channelId, channelQuery.data, recordWatch]);

  useEffect(() => {
    if (!navChannels.some((channel) => channel.id === channelId) && channelsQuery.hasNextPage && !channelsQuery.isFetchingNextPage) {
      void channelsQuery.fetchNextPage();
    }
  }, [navChannels, channelId, channelsQuery]);

  const { now, next } = useMemo(() => {
    const programmes = epgQuery.data ?? [];
    const nowTime = Date.now();
    const current = programmes.find((programme) => new Date(programme.startsAt).getTime() <= nowTime && new Date(programme.endsAt).getTime() > nowTime);
    const following = programmes.find((programme) => new Date(programme.startsAt).getTime() > nowTime) ?? null;
    return { now: current ?? null, next: following };
  }, [epgQuery.data]);

  const navigate = (direction: 'prev' | 'next') => {
    const index = navChannels.findIndex((channel) => channel.id === channelId);
    if (index === -1) return;
    const target = direction === 'next' ? navChannels[(index + 1) % navChannels.length] : navChannels[(index - 1 + navChannels.length) % navChannels.length];
    if (target) router.push(buildWatchHref(target.id, { category, country, q }));
  };

  const goBack = (): void => {
    router.push(lastNonWatchPath || '/live');
  };

  const similar = navChannels.filter((channel) => channel.id !== channelId);

  if (channelQuery.isLoading || !channelQuery.data) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const channel = channelQuery.data;

  return (
    <main className="animate-fade-in pb-16">
      {/* ================= PLAYER PLEIN ÉCRAN ================= */}
      <div className="relative w-full bg-black">
        {playQuery.isLoading ? (
          <div className="flex aspect-video max-h-[78vh] w-full items-center justify-center">
            <Spinner />
          </div>
        ) : playUrls.length > 0 ? (
          <Player
            urls={playUrls}
            title={channel.name}
            initialVolume={volume}
            initialLevel={preferredLevel}
            initialDataSaver={dataSaver}
            onVolumeChange={setVolume}
            onLevelChange={setPreferredLevel}
            onDataSaverChange={setDataSaver}
          />
        ) : (
          <div className="flex aspect-video max-h-[78vh] w-full flex-col items-center justify-center gap-3">
            <EmptyState title="Lecture indisponible" hint="Impossible de récupérer un flux pour cette chaîne." />
            <Button variant="primary" onClick={goBack}>← Retour</Button>
          </div>
        )}

        {/* Chrome superposé */}
        <button
          type="button"
          onClick={goBack}
          aria-label="Retour"
          className={`absolute left-4 top-4 inline-flex items-center gap-1.5 rounded-lg bg-black/50 px-3 py-2 text-sm font-semibold text-white backdrop-blur transition-opacity duration-300 hover:bg-black/70 ${chromeVisible ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        >
          <Icon.ChevronLeft size={16} aria-hidden /> Retour
        </button>

        <div
          className={`absolute right-4 top-4 flex items-center gap-2 transition-opacity duration-300 ${chromeVisible ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        >
          {channel.nowPlaying && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-danger/90 px-2.5 py-1 text-[10px] font-bold tracking-widest text-white">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
              DIRECT
            </span>
          )}
          {viewersQuery.data && viewersQuery.data.count > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-bold text-white backdrop-blur">
              <Icon.Eye size={13} aria-hidden />
              {viewersQuery.data.count}
            </span>
          )}
        </div>
      </div>

      {/* ================= BLOC INFOS ================= */}
      <div className="mx-auto max-w-[1600px] px-4 pt-6 md:px-10">
        <div className="flex flex-wrap items-start gap-4">
          {channel.logoUrl ? (
              <img src={channel.logoUrl} alt="" width={56} height={56} loading="lazy" decoding="async" className="h-14 w-14 shrink-0 object-contain" />
          ) : null}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 truncate text-xl font-extrabold tracking-tight md:text-2xl">{channel.name}</h1>
              {channel.country && <Badge tone="accent" className="shrink-0">{channel.country}</Badge>}
            </div>

            {now ? (
              <div className="mt-2 min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">
                  <span className="mr-2 inline-flex items-center gap-1 rounded-sm bg-danger px-1.5 py-0.5 text-[9px] font-black tracking-widest text-white">EN COURS</span>
                  {now.title}
                </p>
                <p className="mt-0.5 text-xs text-muted">{time(now.startsAt)} – {time(now.endsAt)}</p>
                {next && <p className="mt-1 truncate text-xs text-muted">À suivre : {next.title} · {time(next.startsAt)}</p>}
              </div>
            ) : next ? (
              <p className="mt-2 truncate text-sm text-muted">À suivre : {next.title} · {time(next.startsAt)}</p>
            ) : (
              <p className="mt-2 text-sm text-muted">Aucune programmation pour cette chaîne.</p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <FavoriteToggle channelId={channel.id} />
            <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
              <Button variant="ghost" size="small" onClick={() => navigate('prev')} aria-label="Chaîne précédente" className="!rounded-lg">
                <Icon.ChevronLeft size={16} />
              </Button>
              <Button variant="ghost" size="small" onClick={() => navigate('next')} aria-label="Chaîne suivante" className="!rounded-lg">
                <Icon.ChevronRight size={16} />
              </Button>
            </div>
          </div>
        </div>

        {now && (
          <div className="mt-3 h-[3px] overflow-hidden rounded-full bg-surface-2">
            <ProgrammeProgressInline startsAt={now.startsAt} endsAt={now.endsAt} />
          </div>
        )}
      </div>

      {/* ================= CHAÎNES SIMILAIRES ================= */}
      {similar.length > 0 && (
        <div className="mt-10">
          <NetflixRow
            title={categoryRowTitle(category)}
            subtitle={`${similar.length}`}
            channels={similar.slice(0, 24)}
            seeAllHref={category ? `/live?category=${category}` : undefined}
          />
        </div>
      )}
    </main>
  );
}
