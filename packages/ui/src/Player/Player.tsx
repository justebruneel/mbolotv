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

const MAX_RETRIES = 3;
const MAX_NETWORK_RETRIES = 6;
const DATA_SAVER_MAX_HEIGHT = 480;
const BUFFER_TARGET_SECONDS = 30;
const LOAD_TIMEOUT_MS = 10_000;
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
    let bufferInterval: ReturnType<typeof setInterval> | null = null;
    let loadTimer: ReturnType<typeof setTimeout> | null = null;

    const destroyCurrentHls = (): void => {
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

      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,

        backBufferLength: 60,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        maxBufferSize: 60 * 1000 * 1000,
        maxBufferHole: 0.5,

        liveSyncDurationCount: 5,
        liveMaxLatencyDurationCount: 60,

        startLevel: -1,
        abrEwmaDefaultEstimate: 1_000_000,
        abrBandWidthFactor: 0.8,
        abrMaxWithRealBitrate: true,
        capLevelToPlayerSize: false,
        maxLoadingDelay: 5,
        maxFragLookUpTolerance: 0.5,

        manifestLoadingTimeOut: 8000,
        manifestLoadingMaxRetry: 3,
        levelLoadingTimeOut: 8000,
        levelLoadingMaxRetry: 3,
        fragLoadingTimeOut: 10000,
        fragLoadingMaxRetry: 4,
      });
      hlsRef.current = hls;
      hls.loadSource(urls[urlIndex]);
      hls.attachMedia(el);

      hls.on(Hls.Events.ERROR, (_event, data: ErrorData) => {
        if (cancelled || !data.fatal) return;

        if (data.type === ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
          return;
        }

        if (data.type === ErrorTypes.NETWORK_ERROR) {
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

  return (
    <div className={styles.player}>
      <video ref={videoRef} className={styles.video} controls playsInline />

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