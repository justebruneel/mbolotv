'use client';

import { Button, EmptyState, Icon, Player, Spinner } from '@mbolo/ui';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChannel, usePlayUrl, useActivityHeartbeat } from '../api/queries';
import { usePlayerStore } from '../stores/player';
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

/**
 * Lecteur global : unique instance de <Player> de l'application, montée au
 * niveau du layout pour que la lecture survive à une navigation vers /live ou
 * /favorites (et uniquement elles). Sur /watch il recouvre l'emplacement
 * réservé par la page ; ailleurs sur ces pages il devient une vignette fixe.
 * Le <video> n'est jamais démonté tant que la source ne change pas — c'est ce
 * qui évite de recréer les problèmes de lecture en arrière-plan.
 */
export function GlobalPlayer() {
  const pathname = usePathname();
  const router = useRouter();
  const storeChannelId = usePlayerStore((state) => state.channelId);
  const watchHref = usePlayerStore((state) => state.watchHref);
  const clearSource = usePlayerStore((state) => state.clear);

  const watchId = pathname?.match(/^\/watch\/([^/]+)/)?.[1] ?? null;
  const isWatch = Boolean(watchId);
  // La lecture ne survit à une navigation vers live / favoris que si
  // l'option « Mini-lecteur sur l'accueil » est activée (Préférences).
  const miniPlayerOnBrowse = useSettingsStore((state) => state.miniPlayerOnBrowse);
  const keepAlive = Boolean(pathname && (isWatch || (miniPlayerOnBrowse && (pathname.startsWith('/live') || pathname.startsWith('/favorites')))));
  const channelId = watchId ?? (keepAlive ? storeChannelId : null);

  // Hors pages keep-alive : la lecture s'arrête (démontage du Player) et la
  // source est oubliée — revenir sur live ne doit pas la ressusciter.
  useEffect(() => {
    if (!keepAlive && storeChannelId) clearSource();
  }, [keepAlive, storeChannelId, clearSource]);

  useActivityHeartbeat(channelId ?? undefined);

  const volume = useSettingsStore((state) => state.volume);
  const preferredLevel = useSettingsStore((state) => state.preferredLevel);
  const dataSaver = useSettingsStore((state) => state.dataSaver);
  const autoPlay = useSettingsStore((state) => state.autoPlay);
  const setVolume = useSettingsStore((state) => state.setVolume);
  const setPreferredLevel = useSettingsStore((state) => state.setPreferredLevel);
  const setDataSaver = useSettingsStore((state) => state.setDataSaver);

  const channelQuery = useChannel(channelId ?? '', Boolean(channelId));
  const playQuery = usePlayUrl(channelId ?? '', Boolean(channelId));
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
  // Sur /watch, « follow » tant que l'emplacement est visible ; mini en
  // dessous (mobile) ou hidden (desktop, lecture audio hors écran).
  const [mode, setMode] = useState<Mode>('hidden');

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (): void => setMobileViewport(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const isMini = Boolean(channelId) && (!isWatch || mode === 'mini');

  useEffect(() => {
    if (!mounted || !isWatch || !channelId) return;
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
      const slot = document.getElementById('watch-player-slot');
      if (!slot) {
        // Page watch en cours de chargement (emplacement pas encore monté).
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
  }, [mounted, isWatch, channelId, mobileViewport]);

  const onMiniExpand = useCallback((): void => {
    if (isWatch) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    router.push(watchHref ?? `/watch/${channelId}`);
  }, [isWatch, router, watchHref, channelId]);

  const onMiniClose = useCallback((): void => {
    if (isWatch) goBack();
    else clearSource();
  }, [isWatch, goBack, clearSource]);

  if (!mounted || !channelId) return null;

  const containerClass = !isWatch || mode === 'mini' ? PLAYER_MINI : mode === 'hidden' ? PLAYER_HIDDEN : PLAYER_FOLLOW;

  return (
    <div ref={containerRef} className={containerClass} data-player-root>
      {playQuery.isLoading ? (
        <div className="flex aspect-video w-full items-center justify-center">
          <Spinner />
        </div>
      ) : playUrls.length > 0 ? (
        <Player
          key={channelId}
          urls={playUrls}
          title={channelQuery.data?.name ?? 'Mbolo TV'}
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
          <EmptyState title="Lecture indisponible" hint={playErrorMessage ?? 'Impossible de récupérer un flux pour cette chaîne.'} />
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => void refetchPlayUrl()}>
              Réessayer
            </Button>
            <Button variant="ghost" onClick={goBack}>
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
