'use client';

import { useEffect, useRef, useState } from 'react';
import Hls, { ErrorTypes } from 'hls.js';
import type { ErrorData } from 'hls.js';
import { Spinner } from '../Spinner/Spinner';
import styles from './Player.module.css';

export interface PlayerProps {
  urls: string[];
  title: string;
  initialVolume?: number;
  initialLevel?: number;
  initialDataSaver?: boolean;
  onVolumeChange?: (volume: number) => void;
  onLevelChange?: (level: number) => void;
  onDataSaverChange?: (enabled: boolean) => void;
}

const MAX_RETRIES = 2;
const MAX_NETWORK_RETRIES = 2;
const DATA_SAVER_MAX_HEIGHT = 480;
const BUFFER_TARGET_SECONDS = 30;
const LOAD_TIMEOUT_MS = 10_000;
// Si aucune lecture n'a démarré après ce délai, le flux est considéré comme mort
// (fournisseur injoignable, fenêtre live trop courte…) et on bascule immédiatement.
const STARTUP_DEADLINE_MS = 20_000;
const DEBUG = true; // logs HLS diagnostiques (sauts de timeline live)

interface QualityLevel {
  index: number;
  height: number;
}

function exponentialDelay(retryCount: number): number {
  return Math.min(1000 * 2 ** retryCount, 8000);
}

export function Player({
  urls,
  title,
  initialVolume,
  initialLevel,
  initialDataSaver,
  onVolumeChange,
  onLevelChange,
  onDataSaverChange,
}: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [buffering, setBuffering] = useState(false);
  const [bufferProgress, setBufferProgress] = useState(0);
  const [loadTimeout, setLoadTimeout] = useState(false);
  const [levels, setLevels] = useState<QualityLevel[]>([]);
  const [activeLevel, setActiveLevel] = useState(-1);
  const [selectedLevel, setSelectedLevel] = useState(initialLevel ?? -1);
  const [dataSaver, setDataSaver] = useState(initialDataSaver ?? false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || urls.length === 0) return;
    const el: HTMLVideoElement = video;
    setStatus('loading');
    setLevels([]);
    setBufferProgress(0);
    setLoadTimeout(false);

    let cancelled = false;
    let urlIndex = 0;
    let retries = 0;
    let networkRetries = 0;
    let started = false;
    let bufferInterval: ReturnType<typeof setInterval> | null = null;
    let loadTimer: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

    const destroyCurrentHls = (): void => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      const hls = hlsRef.current;
      if (hls) {
        hls.stopLoad();
        hls.detachMedia();
        hls.destroy();
      }
      hlsRef.current = null;
      video.removeAttribute('src');
      video.load();
    };

    const armLoadTimeout = (): void => {
      if (loadTimer) clearTimeout(loadTimer);
      loadTimer = setTimeout(() => {
        if (!cancelled) setLoadTimeout(true);
      }, LOAD_TIMEOUT_MS);
    };

    const updateBuffer = (): void => {
      if (el.buffered.length === 0) return;
      const currentTime = el.currentTime;
      const bufferedEnd = el.buffered.end(el.buffered.length - 1);
      const bufferAhead = bufferedEnd - currentTime;
      const progress = Math.min(Math.max((bufferAhead / BUFFER_TARGET_SECONDS) * 100, 0), 100);
      setBufferProgress(progress);
    };

    const startOrAdvance = (): void => {
      retries += 1;
      if (retries <= MAX_RETRIES) {
        setTimeout(loadCurrentUrl, exponentialDelay(retries));
      } else if (urlIndex + 1 < urls.length) {
        urlIndex += 1;
        retries = 0;
        networkRetries = 0;
        loadCurrentUrl();
      } else {
        if (!cancelled) setStatus('error');
      }
    };

    function loadCurrentUrl(): void {
      if (cancelled) return;
      destroyCurrentHls();
      setStatus('loading');
      setLevels([]);
      setBufferProgress(0);
      setLoadTimeout(false);
      armLoadTimeout();

      if (!Hls.isSupported()) {
        el.src = urls[urlIndex];
        return;
      }

      started = false;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(() => {
        // Aucune lecture démarrée dans le délai imparti : flux probablement mort
        // (timeout fournisseur, segments expirés…) -> failover immédiat.
        if (!cancelled && !started) startOrAdvance();
      }, STARTUP_DEADLINE_MS);

      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,

        backBufferLength: 30,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 60 * 1000 * 1000,
        maxBufferHole: 0.5,

        // Sync live adaptée aux fenêtres courtes : certaines sources n'ont que
        // quelques segments (~24 s). 3 segments (~12-15 s) derrière le bord
        // laissent une marge de manœuvre si le serveur a un léger lag, tout en
        // restant dans la fenêtre. Resync dès 10 segments d'écart.
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,

        startLevel: -1,
        abrEwmaDefaultEstimate: 1_000_000,
        abrBandWidthFactor: 0.8,
        abrMaxWithRealBitrate: true,
        capLevelToPlayerSize: false,
        maxLoadingDelay: 5,
        // Les serveurs IPTV coupent parfois les segments avec ~0.2 s d'avance
        // ou de retard : tolérance élargie pour ignorer ces micro-écarts.
        maxFragLookUpTolerance: 1.0,

        // Les segments passent par notre proxy NestJS : TTFB légèrement plus
        // élevé qu'en direct fournisseur. On est plus patient avec l'API —
        // le deadline de 20 s (STARTUP_DEADLINE_MS) garde le failover rapide.
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 3,
        levelLoadingTimeOut: 15000,
        levelLoadingMaxRetry: 3,
        fragLoadingTimeOut: 20000,
        fragLoadingMaxRetry: 4,

        // Tolérance avant récupération (recoverMediaError) lors d'une famine
        // du buffer : laisse le temps à un segment lent (via le proxy) d'arriver.
        maxStarvationDelay: 10,
      });
      hlsRef.current = hls;
      hls.loadSource(urls[urlIndex]);
      hls.attachMedia(el);

      hls.on(Hls.Events.ERROR, (_event, data: ErrorData) => {
        if (cancelled || !data.fatal) return;

        if (data.type === ErrorTypes.MEDIA_ERROR) {
          // Avance légèrement pour sauter le segment corrompu avant la
          // récupération (évite de rester bloqué sur une image gelée), sans
          // sortir du buffer déjà chargé.
          if (el.buffered.length > 0 && el.currentTime + 1 < el.buffered.end(el.buffered.length - 1)) {
            el.currentTime += 1;
          }
          hls.recoverMediaError();
          return;
        }

        if (data.type === ErrorTypes.NETWORK_ERROR) {
          // Session expirée ou non autorisée : l'API répond 401/403 (guard)
          // ou 404 sur le manifest (session inconnue). Retenter est inutile :
          // on bascule immédiatement sur l'URL suivante, ou on affiche
          // l'erreur sans épuiser les retries.
          const status = data.response?.code;
          const isMasterManifest =
            typeof data.url === 'string' && data.url.includes('master.m3u8');
          if (status === 401 || status === 403 || (status === 404 && isMasterManifest)) {
            if (urlIndex + 1 < urls.length) {
              urlIndex += 1;
              retries = 0;
              networkRetries = 0;
              destroyCurrentHls();
              loadCurrentUrl();
            } else {
              destroyCurrentHls();
              if (!cancelled) setStatus('error');
            }
            return;
          }

          const manifestOrLevelUnreachable = [
            Hls.ErrorDetails.MANIFEST_LOAD_ERROR,
            Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT,
            Hls.ErrorDetails.LEVEL_LOAD_ERROR,
            Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT,
          ].includes(data.details);

          if (manifestOrLevelUnreachable) {
            // Manifest/level injoignable : inutile de multiplier les retries doux
            // (un flux qui ne répond pas après ~10 s ne répondra pas), on bascule
            // immédiatement sur la variante suivante ou l'erreur finale.
            startOrAdvance();
            return;
          }

          networkRetries += 1;
          if (networkRetries <= MAX_NETWORK_RETRIES) {
            // Tente de relancer le chargement sans détruire le buffer existant
            setTimeout(() => {
              if (!cancelled && hlsRef.current) {
                hlsRef.current.startLoad();
              }
            }, Math.min(1000 * networkRetries, 3000));
            return;
          }
        }

        // Si le réseau ne répond vraiment plus après plusieurs retries doux
        startOrAdvance();
      });

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (cancelled || !hls) return;
        setLevels(hls.levels.map((l, index) => ({ index, height: l.height })));
        setStatus('ready');
        setLoadTimeout(false);
        if (loadTimer) clearTimeout(loadTimer);
        el.play().catch(() => {});
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        if (!cancelled) setActiveLevel(data.level);
      });

      if (DEBUG) {
        hls.on(Hls.Events.FRAG_CHANGED, (_e, data) => {
          console.log(
            `[FRAG_CHANGED] frag.sn=${data.frag.sn}, start=${data.frag.start.toFixed(2)}, duration=${data.frag.duration.toFixed(2)}`,
          );
        });

        hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
          console.log(`[LEVEL_SWITCHED] level=${data.level}`);
        });

        hls.on(Hls.Events.BUFFER_FLUSHED, () => {
          console.log('[BUFFER_FLUSHED]');
        });

        hls.on(Hls.Events.LEVEL_UPDATED, (_e, data) => {
          const liveEdge = data.details.live ? data.details.edge : 0;
          const latency = liveEdge ? liveEdge - el.currentTime : 0;
          console.log(
            `[LIVE_SYNC] currentTime=${el.currentTime.toFixed(2)}, liveEdge=${liveEdge.toFixed(2)}, latency=${latency.toFixed(2)}`,
          );
        });
      }

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        networkRetries = 0;
        updateBuffer();
      });

      if (bufferInterval) clearInterval(bufferInterval);
      bufferInterval = setInterval(() => {
        if (el.buffered.length > 0) {
          const currentTime = el.currentTime;
          const bufferedEnd = el.buffered.end(el.buffered.length - 1);
          const bufferAhead = bufferedEnd - currentTime;
          console.log(
            `[Buffer] Avance : ${bufferAhead.toFixed(1)}s | Téléchargé jusqu'à : ${bufferedEnd.toFixed(1)}s | Position : ${currentTime.toFixed(1)}s`,
          );
        } else {
          console.log('[Buffer] vide');
        }
        updateBuffer();
      }, 1000);
    }

    const onPlaying = (): void => {
      if (cancelled) return;
      started = true;
      retries = 0;
      networkRetries = 0;
      setBuffering(false);
      setLoadTimeout(false);
      if (loadTimer) clearTimeout(loadTimer);
    };
    const onWaiting = (): void => setBuffering(true);
    const onNativeError = (): void => startOrAdvance();

    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('error', onNativeError);

    if (Hls.isSupported()) {
      loadCurrentUrl();
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = urls[urlIndex];
      video.addEventListener('loadedmetadata', () => {
        if (!cancelled) setStatus('ready');
      });
    } else {
      setStatus('error');
    }

    return () => {
      cancelled = true;
      if (bufferInterval) clearInterval(bufferInterval);
      if (loadTimer) clearTimeout(loadTimer);
      destroyCurrentHls();
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('error', onNativeError);
    };
  }, [urls]);

  useEffect(() => {
    const hls = hlsRef.current;
    if (!hls || levels.length === 0) return;
    if (hls.levels.length === 0) return;

    if (dataSaver) {
      const cap = levels.filter((l) => l.height <= DATA_SAVER_MAX_HEIGHT);
      hls.autoLevelCapping = cap.length ? Math.max(...cap.map((l) => l.index)) : 0;
    } else {
      hls.autoLevelCapping = -1;
    }

    hls.currentLevel = selectedLevel;
  }, [dataSaver, selectedLevel, levels]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (initialVolume !== undefined) {
      video.volume = initialVolume;
    }
    const handleVolumeChange = (): void => {
      if (video.volume !== initialVolume) onVolumeChange?.(video.volume);
    };
    video.addEventListener('volumechange', handleVolumeChange);
    return () => video.removeEventListener('volumechange', handleVolumeChange);
  }, [initialVolume, onVolumeChange]);

  const handleVideoClick = (): void => {
    const video = videoRef.current;
    if (!video || status !== 'ready') return;

    if (video.paused) {
      video.play();
    } else {
      video.pause();
    }
  };

  return (
    <div className={styles.player}>
      <video
        ref={videoRef}
        className={styles.video}
        controls
        playsInline
        onClick={handleVideoClick}
      />

      {status !== 'ready' && (
        <div className={styles.overlay}>
          {status === 'loading' ? (
            <>
              <Spinner />
              <div className={styles.progressBar}>
                <div className={styles.progressFill} style={{ width: `${bufferProgress}%` }} />
              </div>
              <p className={styles.hint}>
                {loadTimeout
                  ? 'La chaîne met du temps à répondre…'
                  : bufferProgress > 0
                    ? 'Chargement du flux…'
                    : 'Connexion au serveur…'}
              </p>
            </>
          ) : (
            <>
              <h2 className={styles.title}>Flux indisponible</h2>
              <p className={styles.hint}>
                La diffusion de « {title} » n’est pas accessible pour le moment.
              </p>
            </>
          )}
        </div>
      )}

      {status === 'ready' && buffering && (
        <div className={styles.bufferingOverlay}>
          <Spinner />
        </div>
      )}

      {status === 'ready' && levels.length > 0 && (
        <div className={styles.controls}>
          <select
            className={styles.qualitySelect}
            value={selectedLevel}
            onChange={(e) => {
              const level = Number(e.target.value);
              setSelectedLevel(level);
              onLevelChange?.(level);
            }}
          >
            <option value={-1}>
              Auto {activeLevel >= 0 ? `(${levels.find((l) => l.index === activeLevel)?.height ?? ''}p)` : ''}
            </option>
            {levels
              .slice()
              .sort((a, b) => b.height - a.height)
              .map((l) => (
                <option key={l.index} value={l.index}>
                  {l.height}p
                </option>
              ))}
          </select>

          <label className={styles.dataSaverToggle}>
            <input
              type="checkbox"
              checked={dataSaver}
              onChange={(e) => {
                const enabled = e.target.checked;
                setDataSaver(enabled);
                onDataSaverChange?.(enabled);
              }}
            />
            Économie de données
          </label>
        </div>
      )}
    </div>
  );
}