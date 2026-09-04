'use client';

import { Button, EmptyState, Icon, Player, Spinner } from '@mbolo/ui';
import { usePathname, useRouter } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChannel, usePlayUrl, useVodItem, useVodPlayUrl, useActivityHeartbeat } from '../../shared/api/queries';
import { usePlayerStore, useVodPlayerStore } from '../stores/player';
import { useSettingsStore } from '../stores/settings';
import { internalNavigationCount } from './RouteTracker';

// Vignette du mini-lecteur : au-dessus des onglets bas, sous les menus.
const PLAYER_MINI = 'fixed bottom-[calc(68px+env(safe-area-inset-bottom))] right-3 z-40 w-[232px] overflow-hidden rounded-xl border border-border bg-black shadow-2xl';
// Mode « suit la page watch » : conteneur fixe recalé chaque frame sur
// l'emplacement réservé par la page (#watch-player-slot) via transform —
// écriture DOM impérative, aucun re-render pendant le scroll.
const PLAYER_FOLLOW = 'fixed left-0 top-0 z-30 overflow-hidden bg-black will-change-transform';
// Hors écran (desktop défilé) : invisible mais monté, la lecture continue.
const PLAYER_HIDDEN = 'fixed left-0 top-0 z-30 overflow-hidden bg-black invisible pointer-events-none';

type Mode = 'follow' | 'mini' | 'hidden';

// Position persistée toutes les 5 s : plus fréquent serait marteler
// localStorage à chaque tick du player (500 ms).
const VOD_PROGRESS_WRITE_INTERVAL_MS = 5_000;

function GlobalPlayerInner() {
  const pathname = usePathname();
  const router = useRouter();
  const storeChannelId = usePlayerStore((state) => state.channelId);
  const watchHref = usePlayerStore((state) => state.watchHref);
  const clearSource = usePlayerStore((state) => state.clear);
  const storeVodId = useVodPlayerStore((state) => state.vodItemId);
  const storeVodSeason = useVodPlayerStore((state) => state.season);
  const storeVodEpisode = useVodPlayerStore((state) => state.episode);
  const clearVod = useVodPlayerStore((state) => state.clearVod);

  const watchId = pathname?.match(/^\/watch\/([^/]+)/)?.[1] ?? null;
  // /vod/yt/<videoId> = fiche Nollywood avec son propre lecteur inline :
  // exclue de la capture VOD (sinon 'yt' partirait vers l'API Xtream).
  const routeVodId = pathname?.match(/^\/vod\/(?!yt\/)([^/]+)/)?.[1] ?? null;
  const isWatch = Boolean(watchId);
  const isVodRoute = Boolean(routeVodId);
  // La lecture ne survit à une navigation vers live / favoris que si
  // l'option « Mini-lecteur sur l'accueil » est activée (Préférences).
  const miniPlayerOnBrowse = useSettingsStore((state) => state.miniPlayerOnBrowse);
  // /vod/yt/* (fiche Nollywood) est exclue du keep-alive : elle possède son
  // propre lecteur inline — sans exclusion, le mini-lecteur précédent (live
  // ou VOD Xtream) persiste par-dessus avec ses contrôles => doublons
  // pause/volume/plein écran.
  const keepAlive = Boolean(pathname && (isWatch || isVodRoute || (miniPlayerOnBrowse && (pathname.startsWith('/live') || pathname.startsWith('/favorites') || (pathname.startsWith('/vod') && !pathname.startsWith('/vod/yt/'))))));
  // Priorité : watch > vod (route) > vod (mini) > chaîne. Le heartbeat
  // d'activité ne suit que les chaînes live : l'éco adaptatif mesure la
  // charge du relais résidentiel, que le VOD (sortie directe) n'utilise pas.
  const vodId = routeVodId ?? (keepAlive && !isWatch && !storeChannelId ? storeVodId : null);
  const channelId = watchId ?? (!vodId && keepAlive ? storeChannelId : null);

  // Hors pages keep-alive : la lecture s'arrête (démontage du Player) et la
  // source est oubliée — revenir sur live ne doit pas la ressusciter.
  useEffect(() => {
    if (!keepAlive && storeChannelId) clearSource();
    if (!keepAlive && storeVodId) clearVod();
  }, [keepAlive, storeChannelId, storeVodId, clearSource, clearVod]);

  useActivityHeartbeat(channelId ?? undefined);

  const volume = useSettingsStore((state) => state.volume);
  const preferredLevel = useSettingsStore((state) => state.preferredLevel);
  const dataSaver = useSettingsStore((state) => state.dataSaver);
  const autoPlay = useSettingsStore((state) => state.autoPlay);
  const setVolume = useSettingsStore((state) => state.setVolume);
  const setPreferredLevel = useSettingsStore((state) => state.setPreferredLevel);
  const setDataSaver = useSettingsStore((state) => state.setDataSaver);
  const vodProgress = useSettingsStore((state) => state.vodProgress);
  const recordVodProgress = useSettingsStore((state) => state.recordVodProgress);

  const channelQuery = useChannel(channelId ?? '', Boolean(channelId));
  const playQuery = usePlayUrl(channelId ?? '', Boolean(channelId));
  const vodItemQuery = useVodItem(vodId ?? '', Boolean(vodId));
  const vodPlayQuery = useVodPlayUrl(vodId ?? '', { s: storeVodSeason, e: storeVodEpisode }, Boolean(vodId));

  const playUrls = useMemo(() => {
    if (vodId) return vodPlayQuery.data?.url ? [vodPlayQuery.data.url] : [];
    return playQuery.data?.url ? [playQuery.data.url] : [];
  }, [vodId, vodPlayQuery.data?.url, playQuery.data?.url]);
  const activeQuery = vodId ? vodPlayQuery : playQuery;
  const playErrorMessage = activeQuery.error instanceof Error ? activeQuery.error.message : null;
  const refetchPlayUrl = useCallback(async (): Promise<boolean> => {
    try {
      const result = await activeQuery.refetch();
      return result.isSuccess;
    } catch {
      return false;
    }
  }, [activeQuery]);

  // Reprise VOD : au-delà de 30 s et avant la fin, on repart de la position
  // enregistrée (sinon du début).
  const progressEntry = vodId ? vodProgress[vodId] : undefined;
  const initialTime = useMemo(() => {
    if (!progressEntry || progressEntry.duration <= 0) return undefined;
    if (progressEntry.position < 30 || progressEntry.position >= progressEntry.duration - 30) return undefined;
    return progressEntry.position;
  }, [progressEntry]);
  const lastProgressWriteRef = useRef(0);
  const handleVodProgress = useCallback(
    (seconds: number, duration: number) => {
      if (!vodId) return;
      const now = Date.now();
      if (now - lastProgressWriteRef.current < VOD_PROGRESS_WRITE_INTERVAL_MS) return;
      lastProgressWriteRef.current = now;
      const item = vodItemQuery.data;
      recordVodProgress({
        id: vodId,
        kind: item?.kind ?? 'MOVIE',
        title: item?.title ?? 'Vidéo',
        posterUrl: item?.posterUrl ?? null,
        category: item?.category ?? null,
        position: seconds,
        duration,
        updatedAt: new Date().toISOString(),
      });
    },
    [vodId, vodItemQuery.data, recordVodProgress],
  );

  // Bascule Éco = changement réel de source : on re-demande l'URL de play.
  const handleDataSaverChange = useCallback(
    (next: boolean) => {
      const changed = next !== dataSaver;
      setDataSaver(next);
      if (changed) void refetchPlayUrl();
    },
    [dataSaver, setDataSaver, refetchPlayUrl],
  );

  const goBack = useCallback((): void => {
    if (internalNavigationCount.value > 0 && window.history.length > 1) {
      router.back();
      return;
    }
    router.push(useSettingsStore.getState().lastNonWatchPath || '/live');
  }, [router]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [mobileViewport, setMobileViewport] = useState(false);
  // Sur watch/vod, « follow » tant que l'emplacement est visible ; mini en
  // dessous (mobile) ou hidden (desktop, lecture audio hors écran).
  const [mode, setMode] = useState<Mode>('hidden');

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (): void => setMobileViewport(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const isMini = Boolean(channelId || vodId) && mode === 'mini';
  const slotId = isVodRoute ? 'vod-player-slot' : 'watch-player-slot';

  useEffect(() => {
    if (!mounted || (!isWatch && !isVodRoute) || (!channelId && !vodId)) return;
    let raf = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let observedSlot: Element | null = null;
    const observer = new ResizeObserver(schedule);
    const apply = (next: Mode, rect?: DOMRect): void => {
      const el = containerRef.current;
      if (!el) return;
      setMode((prev) => (prev === next ? prev : next));
      if (next === 'follow' && rect) {
        el.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
        el.style.width = `${rect.width}px`;
        el.style.visibility = '';
      } else {
        el.style.transform = '';
        el.style.width = '';
      }
    };
    const update = (): void => {
      raf = 0;
      const slot = document.getElementById(slotId);
      if (!slot) {
        // Page en cours de chargement (emplacement pas encore monté).
        apply('hidden');
        if (!retryTimer) retryTimer = setTimeout(schedule, 200);
        return;
      }
      if (slot !== observedSlot) {
        // L'emplacement peut être remplacé par React (remount de la page).
        observer.disconnect();
        observer.observe(slot);
        observedSlot = slot;
      }
      const rect = slot.getBoundingClientRect();
      if (mobileViewport && rect.bottom < 0) apply('mini');
      else if (rect.bottom < 0 || rect.top >= window.innerHeight) apply('hidden');
      else apply('follow', rect);
    };
    function schedule(): void {
      if (!raf) raf = requestAnimationFrame(update);
    }
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
      const el = containerRef.current;
      if (el) {
        el.style.transform = '';
        el.style.width = '';
      }
    };
  }, [mounted, isWatch, isVodRoute, channelId, vodId, mobileViewport, slotId]);

  const onMiniExpand = useCallback((): void => {
    if (vodId) router.push(`/vod/${vodId}`);
    else if (isWatch) window.scrollTo({ top: 0, behavior: 'smooth' });
    else router.push(watchHref ?? `/watch/${channelId}`);
  }, [vodId, isWatch, router, watchHref, channelId]);

  const onMiniClose = useCallback((): void => {
    if (vodId) { if (isVodRoute) router.back(); clearVod(); return; }
    if (isWatch) goBack();
    else clearSource();
  }, [vodId, isVodRoute, isWatch, goBack, clearSource, clearVod, router]);

  if (!mounted || (!channelId && !vodId)) return null;

  const playerTitle = vodId ? (vodItemQuery.data?.title ?? 'Mbolo TV') : (channelQuery.data?.name ?? 'Mbolo TV');
  const playerKey = vodId ? `${vodId}-${storeVodSeason}-${storeVodEpisode}` : `${channelId}`;

  const containerClass = !isWatch && !isVodRoute ? PLAYER_MINI : mode === 'hidden' ? PLAYER_HIDDEN : mode === 'mini' ? PLAYER_MINI : PLAYER_FOLLOW;

  return (
    <div ref={containerRef} className={containerClass} data-player-root>
      {activeQuery.isLoading ? (
        <div className="flex aspect-video w-full items-center justify-center">
          <Spinner />
        </div>
      ) : playUrls.length > 0 ? (
        <Player
          key={playerKey}
          urls={playUrls}
          title={playerTitle}
          mode={vodId ? 'vod' : 'live'}
          initialTime={initialTime}
          onProgress={vodId ? handleVodProgress : undefined}
          initialVolume={volume}
          initialLevel={preferredLevel}
          initialDataSaver={dataSaver}
          autoPlay={autoPlay}
          onVolumeChange={setVolume}
          onLevelChange={setPreferredLevel}
          onDataSaverChange={handleDataSaverChange}
          onRefreshSource={refetchPlayUrl}
        />
      ) : (
        <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 p-4 text-center">
          <EmptyState title="Lecture indisponible" hint={playErrorMessage ?? 'Impossible de récupérer un flux pour ce contenu.'} />
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => void refetchPlayUrl()}>
              Réessayer
            </Button>
            <Button variant="ghost" onClick={vodId ? () => router.back() : goBack}>
              ← Retour
            </Button>
          </div>
        </div>
      )}

      {isMini && (
        <>
          <button type="button" onClick={onMiniExpand} aria-label="Agrandir le lecteur" className="absolute inset-0 z-10" />
          <button
            type="button"
            onClick={onMiniExpand}
            aria-label="Agrandir le lecteur"
            className="absolute left-1.5 top-1.5 z-20 rounded-full bg-black/70 p-1.5 text-white backdrop-blur"
          >
            <Icon.Maximize size={13} aria-hidden />
          </button>
          <button
            type="button"
            onClick={onMiniClose}
            aria-label="Fermer le lecteur"
            className="absolute right-1.5 top-1.5 z-20 rounded-full bg-black/70 p-1.5 text-white backdrop-blur"
          >
            <Icon.X size={13} aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}

export function GlobalPlayer() {
  return (
    <Suspense fallback={null}>
      <GlobalPlayerInner />
    </Suspense>
  );
}
