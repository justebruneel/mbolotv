'use client';

import { Badge, Button, EmptyState, Icon, Player, Spinner } from '@mbolo/ui';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChannel, useCategories, useChannelEpg, useChannelRow, useChannelViewers, useInfiniteChannels, usePlayUrl, useActivityHeartbeat } from '../../../../shared/api/queries';
import { FavoriteToggle } from '../../../../shared/components/FavoriteToggle';
import { useSettingsStore } from '../../../../shared/stores/settings';
import { internalNavigationCount } from '../../../../shared/components/RouteTracker';
import { buildWatchHref, formatCategoryName } from '../../../../features/live-tv/utils';
import { NetflixRow } from '../../../../features/live-tv/components/NetflixRow';
import { UpNextList } from '../../../../features/live-tv/components/UpNextList';
import { useQueries } from '@tanstack/react-query';
import { apiGet } from '../../../../shared/api/client';
import type { Channel } from '@mbolo/contracts';

const PAGE_SIZE = 48;
const CHROME_HIDE_DELAY_MS = 3000;

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

function useContinueChannels(): Channel[] {
  const lastWatched = useSettingsStore((state) => state.lastWatched);
  const ids = useMemo(() => lastWatched.map((e) => e.channelId).slice(0, 12), [lastWatched]);
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['channel', id],
      queryFn: () => apiGet<Channel>(`/channels/${id}`),
      staleTime: 5 * 60_000,
      enabled: ids.length > 0,
    })),
  });
  return useMemo(() => {
    if (ids.length === 0) return [];
    const map = new Map<string, Channel>();
    results.forEach((r) => {
      const ch = r.data;
      if (ch) map.set(ch.id, ch);
    });
    return ids.map((id) => map.get(id)).filter((c): c is Channel => Boolean(c));
  }, [ids, results.map((r) => r.dataUpdatedAt).join(',')]);
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
  const categoriesQuery = useCategories();
  const channelsQuery = useInfiniteChannels({ category, country, q }, PAGE_SIZE);
  const navChannels = channelsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const viewersQuery = useChannelViewers(channelId);
  useActivityHeartbeat(channelId);
  const playUrls = useMemo(() => (playQuery.data?.url ? [playQuery.data.url] : []), [playQuery.data?.url]);
  const playErrorMessage = playQuery.error instanceof Error ? playQuery.error.message : null;
  const refetchPlayUrl = useCallback(async (): Promise<boolean> => {
    try {
      const result = await playQuery.refetch();
      return result.isSuccess;
    } catch {
      return false;
    }
  }, [playQuery]);

  // Bascule Éco = changement réel de source : on re-demande l'URL de play
  // (eco=1 lu au moment du fetch → transcodeur ~1 Mbps). Le Player recharge
  // automatiquement quand l'URL change ; si le transcodeur est indisponible,
  // l'API renvoie le flux direct (repli transparent).
  const handleDataSaverChange = useCallback((next: boolean) => {
    const changed = next !== dataSaver;
    setDataSaver(next);
    if (changed) void refetchPlayUrl();
  }, [dataSaver, setDataSaver, refetchPlayUrl]);

  // Index id → {slug, name} de tout l'arbre des dossiers publiés.
  const categoryIndex = useMemo(() => {
    const map = new Map<string, { slug: string; name: string }>();
    const walk = (nodes: typeof categoriesQuery.data): void => {
      for (const node of nodes ?? []) {
        map.set(node.id, { slug: node.slug, name: node.name });
        walk(node.children);
      }
    };
    walk(categoriesQuery.data);
    return map;
  }, [categoriesQuery.data]);
  const currentCategory = channelQuery.data?.categoryId ? categoryIndex.get(channelQuery.data.categoryId) : undefined;
  const similarSlug = currentCategory?.slug;
  const similarQuery = useChannelRow(similarSlug, 24, Boolean(similarSlug));

  // Théâtre
  const [theatre, setTheatre] = useState(false);
  // Toast
  const [toast, setToast] = useState<string | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);
  const handleShare = useCallback(async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: channelQuery.data?.name ?? 'Mbolo TV', url });
      else {
        await navigator.clipboard.writeText(url);
        showToast('Lien copié');
      }
    } catch {
      try {
        await navigator.clipboard.writeText(url);
        showToast('Lien copié');
      } catch {}
    }
  }, [channelQuery.data?.name, showToast]);
  const handleReport = useCallback(() => showToast('Chaîne signalée — merci'), [showToast]);

  // Chrome du player
  const [chromeVisible, setChromeVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bumpChrome = useCallback(() => {
    setChromeVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setChromeVisible(false), CHROME_HIDE_DELAY_MS);
  }, []);
  useEffect(() => {
    bumpChrome();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [bumpChrome]);

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

  const { now, strip } = useMemo(() => {
    const programmes = epgQuery.data ?? [];
    const nowTime = Date.now();
    const current = programmes.find((p) => new Date(p.startsAt).getTime() <= nowTime && new Date(p.endsAt).getTime() > nowTime);
    const idx = current ? programmes.indexOf(current) : programmes.findIndex((p) => new Date(p.startsAt).getTime() > nowTime);
    // Le programme en cours est déjà détaillé dans le bloc d'infos : la bande
    // n'affiche que les suivants, sinon il apparaît en double sur mobile.
    const start = current ? idx + 1 : Math.max(0, idx);
    const slice = programmes.slice(start, start + 6);
    return { now: current ?? null, strip: slice };
  }, [epgQuery.data]);

  const navigate = useCallback(
    (direction: 'prev' | 'next') => {
      const index = navChannels.findIndex((channel) => channel.id === channelId);
      if (index === -1) {
        if (channelsQuery.hasNextPage && !channelsQuery.isFetchingNextPage) void channelsQuery.fetchNextPage();
        return;
      }
      // Si on est à la fin et qu'il reste des pages, charge avant de zapper
      if (direction === 'next' && index === navChannels.length - 1 && channelsQuery.hasNextPage && !channelsQuery.isFetchingNextPage) {
        void channelsQuery.fetchNextPage().then(() => {
          const updated = channelsQuery.data?.pages.flatMap((p) => p.items) ?? navChannels;
          const nextIdx = updated.findIndex((c) => c.id === channelId);
          const target = updated[(nextIdx + 1) % updated.length];
          if (target) router.push(buildWatchHref(target.id, { category, country, q }));
        });
        return;
      }
      const target = direction === 'next' ? navChannels[(index + 1) % navChannels.length] : navChannels[(index - 1 + navChannels.length) % navChannels.length];
      if (target) router.push(buildWatchHref(target.id, { category, country, q }));
    },
    [navChannels, channelId, category, country, q, router, channelsQuery],
  );

  // Raccourcis clavier zap (hors input)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement).isContentEditable) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigate('prev');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigate('next');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  const goBack = (): void => {
    // Retour historique dès qu'une navigation interne a eu lieu : le scroll
    // et l'état de la page d'origine sont restaurés par le routeur (un push
    // les réinitialiserait et polluerait l'historique). Si l'utilisateur a
    // ouvert un lien direct (entrée dans l'app sur watch), fallback sur le
    // dernier chemin non-watch connu, sinon l'accueil.
    if (internalNavigationCount.value > 0 && window.history.length > 1) {
      router.back();
      return;
    }
    router.push(lastNonWatchPath || '/live');
  };

  const fallbackSimilar = useMemo(() => navChannels.filter((channel) => channel.id !== channelId), [navChannels, channelId]);
  const sameCategory = useMemo(
    () => (similarQuery.data?.items ?? []).filter((channel) => channel.id !== channelId),
    [similarQuery.data, channelId],
  );
  const similar = sameCategory.length > 0 ? sameCategory : fallbackSimilar.slice(0, 24);
  const similarTitle = currentCategory
    ? `Similaires · ${formatCategoryName(currentCategory.name)}`
    : 'Chaînes similaires';
  const continueChannels = useContinueChannels();
  const isDown = channelQuery.data?.healthStatus === 'DOWN' || playQuery.error?.message?.includes('404');

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
      {/* ===== PLAYER + FILE « À SUIVRE » : deux colonnes sur desktop, façon YouTube ===== */}
      {/* En théâtre le wrapper passe pleine largeur et la file latérale disparaît. */}
      <div className={`mx-auto ${theatre ? 'max-w-none' : 'max-w-[1600px] lg:flex lg:items-start lg:gap-5'}`}>
        {/* Colonne principale : lecteur + infos */}
        <div className="min-w-0 flex-1">
          {/* ================= PLAYER ================= */}
          <div className="relative w-full bg-black" onMouseMove={bumpChrome} onTouchStart={bumpChrome}>
            {playQuery.isLoading ? (
              <div className="flex aspect-video max-h-[82vh] w-full items-center justify-center">
                <Spinner />
              </div>
            ) : playUrls.length > 0 ? (
              <Player
                key={channelId}
                urls={playUrls}
                title={channel.name}
                initialVolume={volume}
                initialLevel={preferredLevel}
                initialDataSaver={dataSaver}
                onVolumeChange={setVolume}
                onLevelChange={setPreferredLevel}
                onDataSaverChange={handleDataSaverChange}
                onRefreshSource={refetchPlayUrl}
              />
            ) : (
              <div className="flex aspect-video max-h-[82vh] w-full flex-col items-center justify-center gap-3">
                <EmptyState
                  title="Lecture indisponible"
                  hint={playErrorMessage ?? 'Impossible de récupérer un flux pour cette chaîne.'}
                />
                <div className="flex items-center gap-2">
                  <Button variant="primary" onClick={() => void refetchPlayUrl()}>
                    Réessayer
                  </Button>
                  <Button variant="ghost" onClick={goBack}>
                    ← Retour
                  </Button>
                  <Button variant="ghost" onClick={handleReport} className="hidden sm:inline-flex">
                    Signaler
                  </Button>
                </div>
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

            {/* Bouton théâtre (desktop) */}
            <button
              type="button"
              onClick={() => setTheatre((v) => !v)}
              aria-label={theatre ? 'Quitter le mode théâtre' : 'Mode théâtre'}
              className={`absolute bottom-4 right-4 hidden items-center gap-1.5 rounded-lg bg-black/50 px-2.5 py-1.5 text-xs font-bold text-white backdrop-blur hover:bg-black/70 md:inline-flex ${chromeVisible ? 'opacity-100' : 'pointer-events-none opacity-0'} transition-opacity`}
            >
              {theatre ? <Icon.Minimize size={14} aria-hidden /> : <Icon.Maximize size={14} aria-hidden />}
              {theatre ? 'Quitter théâtre' : 'Théâtre'}
            </button>
          </div>

          {/* ================= BLOC INFOS ================= */}
          <div className={`px-4 pt-6 md:px-10 ${theatre ? 'bg-surface/30 backdrop-blur' : 'lg:px-0'}`}>
            <div className="flex flex-wrap items-start gap-4">
              {channel.logoUrl ? (
                <img src={channel.logoUrl} alt="" width={56} height={56} loading="lazy" decoding="async" className="h-14 w-14 shrink-0 rounded-xl border border-white/10 bg-white p-1 object-contain shadow-sm" />
              ) : null}

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="min-w-0 truncate text-xl font-extrabold tracking-tight md:text-2xl">{channel.name}</h1>
                  {channel.country && <Badge tone="accent" className="shrink-0">{channel.country}</Badge>}
                  {currentCategory && <Badge tone="accent" className="shrink-0 hidden sm:inline-flex">{formatCategoryName(currentCategory.name)}</Badge>}
                  {isDown && <Badge tone="accent" className="shrink-0 bg-danger text-white">Hors ligne</Badge>}
                </div>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <FavoriteToggle channelId={channel.id} />
                <Button variant="ghost" size="small" onClick={handleShare} aria-label="Partager" className="!rounded-lg">
                  <Icon.Link size={16} aria-hidden /> <span className="hidden sm:inline">Partager</span>
                </Button>
                {isDown && (
                  <Button variant="ghost" size="small" onClick={handleReport} aria-label="Signaler chaîne hors ligne">
                    Signaler
                  </Button>
                )}
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

            {/* EPG strip : 6 prochains programmes enrichis TMDB */}
            {strip.length > 0 && (
              <div className="mt-4 flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {strip.map((prog) => {
                  const enriched = prog as unknown as {
                    type?: string | null;
                    posterUrl?: string | null;
                    backdropUrl?: string | null;
                    trailerUrl?: string | null;
                    genres?: string[] | null;
                    year?: number | null;
                    seasonNumber?: number | null;
                    episodeNumber?: number | null;
                  };
                  const thumb = enriched.backdropUrl ?? enriched.posterUrl ?? prog.imageUrl ?? null;
                  return (
                    <div
                      key={prog.id}
                      className="group relative w-[240px] shrink-0 overflow-hidden rounded-xl border border-border bg-surface text-left transition hover:shadow-md sm:w-[260px]"
                    >
                      {thumb && (
                        <div className="h-20 w-full overflow-hidden bg-surface-2">
                          <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
                        </div>
                      )}
                      <div className="p-3">
                        <div className="flex items-center gap-1.5">
                          {enriched.type && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">{enriched.type}</span>}
                          {enriched.year && <span className="text-[11px] text-muted">{enriched.year}</span>}
                          {enriched.seasonNumber && <span className="text-[11px] text-muted">S{enriched.seasonNumber} E{enriched.episodeNumber ?? ''}</span>}
                        </div>
                        <p className="mt-1 truncate text-xs font-bold text-foreground">{prog.title}</p>
                        {enriched.genres && enriched.genres.length > 0 && <p className="truncate text-[11px] text-muted">{enriched.genres.slice(0, 2).join(' · ')}</p>}
                        <p className="text-[11px] text-muted">
                          {time(prog.startsAt)} – {time(prog.endsAt)}
                        </p>
                        {prog.description && <p className="mt-1 line-clamp-2 text-xs leading-snug text-muted">{prog.description}</p>}
                        {enriched.trailerUrl && (
                          <a
                            href={enriched.trailerUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-flex items-center gap-1 rounded-full bg-danger px-2.5 py-1 text-xs font-bold text-white hover:bg-danger/90"
                          >
                            <Icon.Play size={12} aria-hidden /> Bande-annonce
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <p className="mt-2 text-xs text-faint">Raccourcis : ← → zapper · k pause · f plein écran · m mute</p>
          </div>
        </div>

        {/* File « À suivre » : liste zapable collée à droite du lecteur
            (desktop uniquement ; en théâtre la rangée Similaires la remplace) */}
        {!theatre && similar.length > 0 && (
          <aside
            aria-label="Chaînes à suivre"
            className="hidden lg:sticky lg:top-[72px] lg:block lg:max-h-[calc(100vh-88px)] lg:w-[360px] lg:shrink-0 lg:overflow-y-auto lg:pr-1.5 [scrollbar-width:thin] xl:w-[400px]"
          >
            <UpNextList
              title="À suivre"
              channels={similar}
              context={{ category, country, q }}
              seeAllHref={similarSlug ? `/live?category=${similarSlug}` : category ? `/live?category=${category}` : undefined}
            />
          </aside>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-bg shadow-lg animate-slide-up">
          {toast}
        </div>
      )}

      {/* ================= REPRENDRE ================= */}
      {continueChannels.length > 0 && (
        <div className="mt-8">
          <NetflixRow title="Reprendre" subtitle="Continuer à regarder" channels={continueChannels} />
        </div>
      )}

      {/* ================= CHAÎNES SIMILAIRES ================= */}
      {/* Masquée sur desktop hors théâtre : la file « À suivre » la remplace. */}
      {similar.length > 0 && (
        <div className={`mt-10 ${theatre ? '' : 'lg:hidden'}`}>
          <NetflixRow
            title={similarTitle}
            subtitle={`${similar.length}`}
            channels={similar}
            seeAllHref={similarSlug ? `/live?category=${similarSlug}` : category ? `/live?category=${category}` : undefined}
          />
        </div>
      )}
    </main>
  );
}
