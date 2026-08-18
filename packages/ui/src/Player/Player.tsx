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
const STARTUP_DEADLINE_MS = 20_000;
const DEBUG = false;

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
  const urlsKey = urls.join('\n');

  useEffect(() => {
    const video = videoRef.current;
    if (!video || urls.length === 0) return;
    const el = video;
    setStatus('loading');
    setLevels([]);
    setActiveLevel(-1);
    setBufferProgress(0);
    setLoadTimeout(false);

    let cancelled = false;
    let urlIndex = 0;
    let retries = 0;
    let networkRetries = 0;
    let started = false;
    let loadTimer: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = (): void => {
      if (loadTimer) clearTimeout(loadTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (retryTimer) clearTimeout(retryTimer);
      loadTimer = null;
      deadlineTimer = null;
      retryTimer = null;
    };

    const destroyCurrentHls = (): void => {
      const hls = hlsRef.current;
      if (hls) {
        hls.stopLoad();
        hls.detachMedia();
        hls.destroy();
      }
      hlsRef.current = null;
      el.removeAttribute('src');
      el.load();
    };

    const armLoadTimeout = (): void => {
      if (loadTimer) clearTimeout(loadTimer);
      loadTimer = setTimeout(() => {
        if (!cancelled) setLoadTimeout(true);
      }, LOAD_TIMEOUT_MS);
    };

    const updateBuffer = (): void => {
      if (el.buffered.length === 0) return;
      const bufferedEnd = el.buffered.end(el.buffered.length - 1);
      const bufferAhead = bufferedEnd - el.currentTime;
      setBufferProgress(Math.min(Math.max((bufferAhead / BUFFER_TARGET_SECONDS) * 100, 0), 100));
    };

    const markReady = (): void => {
      if (cancelled) return;
      started = true;
      retries = 0;
      networkRetries = 0;
      setStatus('ready');
      setBuffering(false);
      setLoadTimeout(false);
      if (loadTimer) clearTimeout(loadTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    };

    const startOrAdvance = (): void => {
      if (cancelled) return;
      retries += 1;
      if (retries <= MAX_RETRIES) {
        retryTimer = setTimeout(loadCurrentUrl, exponentialDelay(retries));
        return;
      }
      if (urlIndex + 1 < urls.length) {
        urlIndex += 1;
        retries = 0;
        networkRetries = 0;
        loadCurrentUrl();
        return;
      }
      setStatus('error');
    };

    function loadCurrentUrl(): void {
      if (cancelled) return;
      clearTimers();
      destroyCurrentHls();
      setStatus('loading');
      setLevels([]);
      setActiveLevel(-1);
      setBufferProgress(0);
      setLoadTimeout(false);
      armLoadTimeout();

      if (!Hls.isSupported()) {
        el.src = urls[urlIndex];
        el.load();
        return;
      }

      started = false;
      deadlineTimer = setTimeout(() => {
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
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        startLevel: -1,
        abrEwmaDefaultEstimate: 1_000_000,
        abrBandWidthFactor: 0.8,
        abrMaxWithRealBitrate: true,
        capLevelToPlayerSize: true,
        maxLoadingDelay: 5,
        maxFragLookUpTolerance: 1.0,
        manifestLoadingTimeOut: 15_000,
        manifestLoadingMaxRetry: 3,
        levelLoadingTimeOut: 15_000,
        levelLoadingMaxRetry: 3,
        fragLoadingTimeOut: 20_000,
        fragLoadingMaxRetry: 4,
        maxStarvationDelay: 10,
      });
      hlsRef.current = hls;
      hls.loadSource(urls[urlIndex]);
      hls.attachMedia(el);

      hls.on(Hls.Events.ERROR, (_event, data: ErrorData) => {
        if (cancelled || !data.fatal) return;
        if (data.type === ErrorTypes.MEDIA_ERROR) {
          if (el.buffered.length > 0 && el.currentTime + 1 < el.buffered.end(el.buffered.length - 1)) el.currentTime += 1;
          hls.recoverMediaError();
          return;
        }
        if (data.type === ErrorTypes.NETWORK_ERROR) {
          const responseStatus = data.response?.code;
          const isMasterManifest = typeof data.url === 'string' && data.url.includes('master.m3u8');
          if (responseStatus === 401 || responseStatus === 403 || (responseStatus === 404 && isMasterManifest)) {
            if (urlIndex + 1 < urls.length) {
              urlIndex += 1;
              retries = 0;
              networkRetries = 0;
              loadCurrentUrl();
            } else setStatus('error');
            return;
          }
          const manifestOrLevelUnreachable = [
            Hls.ErrorDetails.MANIFEST_LOAD_ERROR,
            Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT,
            Hls.ErrorDetails.LEVEL_LOAD_ERROR,
            Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT,
          ].includes(data.details);
          if (manifestOrLevelUnreachable) {
            startOrAdvance();
            return;
          }
          networkRetries += 1;
          if (networkRetries <= MAX_NETWORK_RETRIES) {
            retryTimer = setTimeout(() => {
              if (!cancelled && hlsRef.current === hls) hls.startLoad();
            }, Math.min(1000 * networkRetries, 3000));
            return;
          }
        }
        startOrAdvance();
      });

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (cancelled || hlsRef.current !== hls) return;
        setLevels(hls.levels.map((level, index) => ({ index, height: level.height })));
        void el.play().catch(() => undefined);
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        if (!cancelled) setActiveLevel(data.level);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        networkRetries = 0;
        updateBuffer();
      });
      if (DEBUG) hls.on(Hls.Events.FRAG_CHANGED, (_event, data) => console.debug('[HLS] fragment', data.frag.sn));
    }

    const onPlaying = (): void => markReady();
    const onCanPlay = (): void => {
      if (!Hls.isSupported()) markReady();
    };
    const onWaiting = (): void => setBuffering(true);
    const onNativeError = (): void => startOrAdvance();

    video.addEventListener('playing', onPlaying);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('error', onNativeError);
    if (Hls.isSupported()) loadCurrentUrl();
    else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = urls[urlIndex];
      video.load();
    } else setStatus('error');

    return () => {
      cancelled = true;
      clearTimers();
      destroyCurrentHls();
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('error', onNativeError);
    };
  }, [urlsKey]);

  useEffect(() => {
    const hls = hlsRef.current;
    if (!hls || levels.length === 0 || hls.levels.length === 0) return;
    hls.autoLevelCapping = dataSaver
      ? Math.max(0, ...levels.filter((level) => level.height <= DATA_SAVER_MAX_HEIGHT).map((level) => level.index))
      : -1;
    hls.currentLevel = dataSaver ? -1 : selectedLevel;
  }, [dataSaver, selectedLevel, levels]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || initialVolume === undefined) return;
    video.volume = initialVolume;
    const handleVolumeChange = (): void => onVolumeChange?.(video.volume);
    video.addEventListener('volumechange', handleVolumeChange);
    return () => video.removeEventListener('volumechange', handleVolumeChange);
  }, [initialVolume, onVolumeChange]);

  const handleVideoClick = (): void => {
    const video = videoRef.current;
    if (!video || status !== 'ready') return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  };

  return (
    <div className={styles.player}>
      <video ref={videoRef} className={styles.video} controls playsInline onClick={handleVideoClick} />
      {status !== 'ready' && (
        <div className={styles.overlay} role="status" aria-live="polite">
          {status === 'loading' ? (
            <>
              <Spinner />
              <div className={styles.progressBar} aria-hidden="true"><div className={styles.progressFill} style={{ width: `${bufferProgress}%` }} /></div>
              <p className={styles.hint}>{loadTimeout ? 'La chaîne met du temps à répondre…' : bufferProgress > 0 ? 'Chargement du flux…' : 'Connexion au serveur…'}</p>
            </>
          ) : (
            <><h2 className={styles.title}>Flux indisponible</h2><p className={styles.hint}>La diffusion de « {title} » n’est pas accessible pour le moment.</p></>
          )}
        </div>
      )}
      {status === 'ready' && buffering && <div className={styles.bufferingOverlay} role="status" aria-label="Mise en mémoire tampon"><Spinner /></div>}
      {status === 'ready' && levels.length > 0 && (
        <div className={styles.controls}>
          <select className={styles.qualitySelect} value={dataSaver ? -1 : selectedLevel} aria-label="Qualité vidéo" onChange={(event) => { const level = Number(event.target.value); setSelectedLevel(level); onLevelChange?.(level); }}>
            <option value={-1}>Auto{activeLevel >= 0 ? ` (${levels.find((level) => level.index === activeLevel)?.height ?? ''}p)` : ''}</option>
            {levels.slice().sort((a, b) => b.height - a.height).map((level) => <option key={level.index} value={level.index}>{level.height}p</option>)}
          </select>
          <label className={styles.dataSaverToggle}><input type="checkbox" checked={dataSaver} onChange={(event) => { const enabled = event.target.checked; setDataSaver(enabled); onDataSaverChange?.(enabled); }} />Économie de données</label>
        </div>
      )}
    </div>
  );
}
