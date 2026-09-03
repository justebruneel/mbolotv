'use client';

import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../../../shared/stores/settings';
import { youtubeProgressId } from '../../../shared/stores/youtubeFavorites';

// Lecteur YouTube intégré DANS notre lecteur (même slot, même chrome autour)
// via l'IFrame Player API : lecture, seek de reprise, progression et fin sont
// pontés vers le store existant (vodProgress) — « Reprendre » et la barre de
// progression fonctionnent comme pour le VOD Xtream. Conforme aux CGU YouTube
// (player officiel, pas d'extraction de flux).
type YoutubePlayerStateMap = { UNSTARTED: number; ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number };
interface YoutubePlayerInstance {
  destroy(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
}
interface YoutubePlayerOptions {
  host?: string;
  videoId?: string;
  width?: string | number;
  height?: string | number;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (event: { target: YoutubePlayerInstance }) => void;
    onStateChange?: (event: { data: number }) => void;
    onError?: () => void;
  };
}
declare global {
  interface Window {
    YT?: { Player: new (element: HTMLElement, options: YoutubePlayerOptions) => YoutubePlayerInstance; PlayerState: YoutubePlayerStateMap };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<void> | null = null;
function loadYoutubeApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'));
  if (window.YT?.Player) return Promise.resolve();
  if (!apiPromise) {
    apiPromise = new Promise<void>((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof previous === 'function') {
          try { previous(); } catch { /* handler précédent défaillant : ignoré */ }
        }
        resolve();
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => {
        apiPromise = null;
        reject(new Error('API YouTube indisponible'));
      };
      document.head.appendChild(script);
    });
  }
  return apiPromise;
}

export function YoutubePlayer({ videoId, title, posterUrl, startAt }: { videoId: string; title: string; posterUrl: string | null; startAt: number }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const recordVodProgress = useSettingsStore((state) => state.recordVodProgress);
  const metaRef = useRef({ title, posterUrl });
  metaRef.current = { title, posterUrl };
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let player: YoutubePlayerInstance | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const progressId = youtubeProgressId(videoId);
    const pushProgress = (): void => {
      if (!player) return;
      try {
        const duration = Math.floor(player.getDuration() || 0);
        const position = Math.floor(player.getCurrentTime() || 0);
        if (duration <= 0) return;
        recordVodProgress({
          id: progressId,
          kind: 'MOVIE',
          title: metaRef.current.title,
          posterUrl: metaRef.current.posterUrl,
          category: 'Nollywood',
          position,
          duration,
          updatedAt: new Date().toISOString(),
        });
      } catch { /* player pas encore prêt : ignoré */ }
    };
    void loadYoutubeApi()
      .then(() => {
        if (cancelled || !slotRef.current || !window.YT) return;
        player = new window.YT.Player(slotRef.current, {
          host: 'https://www.youtube-nocookie.com',
          videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 1,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            ...(startAt > 10 ? { start: Math.floor(startAt) } : {}),
          },
          events: {
            onReady: (event) => {
              try {
                if (startAt > 10) event.target.seekTo(Math.floor(startAt), true);
              } catch { /* seek initial ignoré */ }
              timer = setInterval(pushProgress, 5000);
            },
            onStateChange: (event) => {
              // Pause / fin : persister aussitôt (pas d'attente du tick 5 s).
              if (event.data === window.YT?.PlayerState.PAUSED || event.data === window.YT?.PlayerState.ENDED) pushProgress();
            },
            onError: () => {
              if (!cancelled) setFailed(true);
            },
          },
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      try { player?.destroy(); } catch { /* déjà détruit */ }
    };
  }, [videoId, startAt, recordVodProgress]);

  if (failed) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-black p-6 text-center">
        <p className="text-sm font-semibold text-white">Lecture indisponible ici pour le moment.</p>
        <a href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noreferrer" className="rounded-xl bg-accent px-4 py-2.5 text-sm font-bold text-on-accent">
          Regarder sur YouTube
        </a>
      </div>
    );
  }
  return <div ref={slotRef} className="h-full w-full" />;
}
