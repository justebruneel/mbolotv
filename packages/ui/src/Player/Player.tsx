'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls, { ErrorTypes } from 'hls.js';
import type { ErrorData } from 'hls.js';
import { Spinner } from '../Spinner/Spinner';
import { Icon } from '../icons';
import styles from './Player.module.css';

export interface PlayerProps { urls: string[]; title: string; initialVolume?: number; initialLevel?: number; initialDataSaver?: boolean; onVolumeChange?: (volume: number) => void; onLevelChange?: (level: number) => void; onDataSaverChange?: (enabled: boolean) => void; }
interface QualityLevel { index: number; height: number; bitrate?: number; }
interface PlaybackStats { startupMs: number | null; rebufferCount: number; bufferAhead: number; bitrate: number | null; latency: number | null; }
interface GestureState { startX: number; startY: number; startTime: number; }
interface NetworkInformationLike { effectiveType?: string; downlink?: number; saveData?: boolean; addEventListener?: (type: string, listener: () => void) => void; removeEventListener?: (type: string, listener: () => void) => void; }

const MAX_RETRIES = 2;
const MAX_NETWORK_RETRIES = 3;
const DATA_SAVER_MAX_HEIGHT = 480;
const STARTUP_DEADLINE_MS = 30_000;
const MIN_VIABLE_BUFFER_SECONDS = 4;
const CONTROLS_HIDE_DELAY_MS = 3_000;
const MOBILE_CONTROLS_HIDE_DELAY_MS = 4_000;
const GESTURE_THRESHOLD = 40;

function exponentialDelay(attempt: number): number { return Math.min(1000 * 2 ** attempt, 8000); }
function formatBitrate(bps: number | undefined): string { if (!bps) return ''; if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`; return `${Math.round(bps / 1000)} kbps`; }
function heightFromBitrate(bps: number | undefined): number { if (!bps) return 0; if (bps < 500_000) return 360; if (bps < 1_500_000) return 480; if (bps < 3_500_000) return 720; if (bps < 6_000_000) return 1080; return 1440; }
function formatDuration(ms: number | null): string { return ms === null ? '…' : `${(ms / 1000).toFixed(1)} s`; }
function formatBuffer(seconds: number): string { return `${Math.max(0, seconds).toFixed(1)} s`; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function networkProfile(): { estimate: number; capHeight: number | null; buffer: number; liveSyncCount: number; startBuffer: number } {
  const conn = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  const type = conn?.effectiveType;
  const downlink = conn?.downlink ?? 0;
  if (conn?.saveData || type === 'slow-2g' || type === '2g' || (downlink > 0 && downlink < 1)) return { estimate: 350_000, capHeight: 360, buffer: 20, liveSyncCount: 7, startBuffer: 6 };
  if (type === '3g' || (downlink > 0 && downlink < 3)) return { estimate: 750_000, capHeight: 720, buffer: 26, liveSyncCount: 8, startBuffer: 10 };
  return { estimate: 1_200_000, capHeight: null, buffer: 36, liveSyncCount: 7, startBuffer: 12 };
}
function getNetworkInfo(): { effectiveType: string; downlink: number; saveData: boolean } {
  const conn = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  return { effectiveType: conn?.effectiveType ?? 'unknown', downlink: conn?.downlink ?? 0, saveData: conn?.saveData ?? false };
}
function getErrorMessage(errorType: string | null, httpCode: number | null): string {
  if (httpCode === 401 || httpCode === 403) return 'Session expirée ou accès refusé. Veuillez vous reconnecter.';
  if (httpCode === 404) return 'Flux introuvable. La chaîne n\'est peut-être plus disponible.';
  if (httpCode && httpCode >= 500) return 'Le serveur rencontre un problème. Réessayez dans quelques instants.';
  if (errorType === 'networkError') return 'Problème de connexion réseau. Vérifiez votre connexion internet.';
  if (errorType === 'mediaError') return 'Erreur de lecture média. Le flux semble corrompu.';
  return 'Le fournisseur ne répond pas ou la session a expiré.';
}

export function Player({ urls, title, initialVolume, initialLevel, initialDataSaver, onVolumeChange, onLevelChange, onDataSaverChange }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const retryRef = useRef<(() => void) | null>(null);
  const networkCapRef = useRef(-1);
  const selectedLevelRef = useRef(initialLevel ?? -1);
  const startupAtRef = useRef(0);
  const rebufferCountRef = useRef(0);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureRef = useRef<GestureState | null>(null);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [buffering, setBuffering] = useState(false);
  const [levels, setLevels] = useState<QualityLevel[]>([]);
  const [activeLevel, setActiveLevel] = useState(-1);
  const [selectedLevel, setSelectedLevel] = useState(initialLevel ?? -1);
  const [dataSaver, setDataSaver] = useState(initialDataSaver ?? false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [stats, setStats] = useState<PlaybackStats>({ startupMs: null, rebufferCount: 0, bufferAhead: 0, bitrate: null, latency: null });
  const [retrying, setRetrying] = useState(false);
  const [errorInfo, setErrorInfo] = useState<{ type: string | null; httpCode: number | null }>({ type: null, httpCode: null });
  const [volume, setVolume] = useState(initialVolume ?? 1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isPip, setIsPip] = useState(false);
  const [liveProgress, setLiveProgress] = useState(0);
  const [liveEdge, setLiveEdge] = useState(0);
  const [bandwidth, setBandwidth] = useState<number | null>(null);
  const [gestureOverlay, setGestureOverlay] = useState<{ type: 'volume' | 'seek'; value: number } | null>(null);
  const gestureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [activePopup, setActivePopup] = useState<'volume' | 'quality' | null>(null);
  const [pipSupported, setPipSupported] = useState(true);
  const [fsSupported, setFsSupported] = useState(true);
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false);
  const isIosRef = useRef(false);
  const startBufferRef = useRef(12);
  const urlsKey = useMemo(() => urls.join('\n'), [urls]);
  selectedLevelRef.current = selectedLevel;

  useEffect(() => {
    const mq = window.matchMedia('(hover: none) and (pointer: coarse)');
    const check = () => { const mobile = mq.matches || navigator.maxTouchPoints > 0; setIsMobile(mobile); isIosRef.current = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); };
    check(); mq.addEventListener('change', check); return () => mq.removeEventListener('change', check);
  }, []);
  useEffect(() => { setPipSupported(document.pictureInPictureEnabled); const el = containerRef.current; const hasNativeFs = Boolean(el && ('requestFullscreen' in el || 'webkitRequestFullscreen' in el)); const hasWebkitFs = typeof document !== 'undefined' && 'webkitEnterFullscreen' in HTMLVideoElement.prototype; setFsSupported(hasNativeFs || hasWebkitFs || isMobile); }, [isMobile]);
  const hideDelay = isMobile ? MOBILE_CONTROLS_HIDE_DELAY_MS : CONTROLS_HIDE_DELAY_MS;
  const showControls = useCallback(() => { setControlsVisible(true); if (hideTimerRef.current) clearTimeout(hideTimerRef.current); hideTimerRef.current = setTimeout(() => setControlsVisible(false), hideDelay); }, [hideDelay]);
  useEffect(() => { if (status !== 'ready') { setControlsVisible(true); if (hideTimerRef.current) clearTimeout(hideTimerRef.current); } }, [status]);
  useEffect(() => { const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement)); document.addEventListener('fullscreenchange', onFsChange); return () => document.removeEventListener('fullscreenchange', onFsChange); }, []);
  const exitPseudoFullscreen = useCallback(() => { setIsPseudoFullscreen(false); document.body.style.overflow = ''; }, []);
  useEffect(() => { const video = videoRef.current; if (!video) return; const onEnterPiP = () => setIsPip(true); const onLeavePiP = () => setIsPip(false); video.addEventListener('enterpictureinpicture', onEnterPiP); video.addEventListener('leavepictureinpicture', onLeavePiP); return () => { video.removeEventListener('enterpictureinpicture', onEnterPiP); video.removeEventListener('leavepictureinpicture', onLeavePiP); }; }, []);
  useEffect(() => { if (status !== 'ready') return; const video = videoRef.current; if (!video) return; let raf: number; const tick = () => { if (video.buffered.length > 0) { const bufferedEnd = video.buffered.end(video.buffered.length - 1); const ahead = Math.max(0, bufferedEnd - video.currentTime); const edge = liveEdge > 0 ? liveEdge : bufferedEnd; setLiveProgress(edge > 0 ? clamp((video.currentTime / edge) * 100, 0, 100) : 0); setLiveEdge((prev) => Math.max(prev, bufferedEnd)); setStats((c) => ({ ...c, bufferAhead: ahead })); } raf = requestAnimationFrame(tick); }; raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf); }, [status, liveEdge]);
  const toggleMute = useCallback(() => { const video = videoRef.current; if (!video) return; video.muted = !video.muted; setMuted(video.muted); }, []);
  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => { const video = videoRef.current; if (!video) return; const v = Number(e.target.value); video.volume = v; video.muted = v === 0; setVolume(v); setMuted(v === 0); onVolumeChange?.(v); }, [onVolumeChange]);
  const toggleFullscreen = useCallback(() => { const video = videoRef.current; const el = containerRef.current; if (!video || !el) return; if (document.fullscreenElement || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement) { const exitFn = document.exitFullscreen || (document as Document & { webkitExitFullscreen?: () => Promise<void> }).webkitExitFullscreen; if (exitFn) void exitFn.call(document); return; } if (isPseudoFullscreen) { exitPseudoFullscreen(); return; } if (isIosRef.current && 'webkitEnterFullscreen' in video) { void (video as HTMLVideoElement & { webkitEnterFullscreen: () => void }).webkitEnterFullscreen(); return; } const fsFn = el.requestFullscreen || (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen; if (fsFn) void fsFn.call(el).catch(() => { setIsPseudoFullscreen(true); document.body.style.overflow = 'hidden'; }); else { setIsPseudoFullscreen(true); document.body.style.overflow = 'hidden'; } }, [isPseudoFullscreen, exitPseudoFullscreen]);
  const togglePip = useCallback(async () => { const video = videoRef.current; if (!video) return; try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else if (document.pictureInPictureEnabled) await video.requestPictureInPicture(); } catch { /* PiP non disponible */ } }, []);
  const togglePlayback = useCallback(() => { const video = videoRef.current; if (!video || status !== 'ready') return; if (video.paused) void video.play().catch(() => setAutoplayBlocked(true)); else video.pause(); }, [status]);
  const handleVideoClick = useCallback(() => { if (isMobile) { if (controlsVisible) { setControlsVisible(false); setActivePopup(null); } else showControls(); } else togglePlayback(); }, [isMobile, controlsVisible, showControls, togglePlayback]);
  const closePopup = useCallback(() => { setActivePopup(null); showControls(); }, [showControls]);
  const handleTouchStart = useCallback((e: React.TouchEvent) => { if (status !== 'ready') return; const touch = e.touches[0]; gestureRef.current = { startX: touch.clientX, startY: touch.clientY, startTime: Date.now() }; }, [status]);
  const handleTouchMove = useCallback((e: React.TouchEvent) => { if (status !== 'ready' || !gestureRef.current || !containerRef.current) return; const touch = e.touches[0]; const rect = containerRef.current.getBoundingClientRect(); const dx = touch.clientX - gestureRef.current.startX; const dy = touch.clientY - gestureRef.current.startY; const absDx = Math.abs(dx); const absDy = Math.abs(dy); if (absDx < GESTURE_THRESHOLD / 2 && absDy < GESTURE_THRESHOLD / 2) return; if (absDx > absDy) { const ratio = clamp(dx / rect.width, -0.5, 0.5); setGestureOverlay({ type: 'seek', value: Math.round(50 + ratio * 100) }); } else { const video = videoRef.current; if (!video) return; const ratio = clamp(-dy / rect.height, -0.5, 0.5); const newVol = clamp(video.volume + ratio, 0, 1); video.volume = newVol; video.muted = newVol === 0; setVolume(newVol); setMuted(newVol === 0); onVolumeChange?.(newVol); setGestureOverlay({ type: 'volume', value: Math.round(newVol * 100) }); } }, [status, onVolumeChange]);
  const handleTouchEnd = useCallback(() => { gestureRef.current = null; if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current); gestureTimerRef.current = setTimeout(() => setGestureOverlay(null), 600); }, []);
  useEffect(() => { if (status !== 'ready') return; const handleKey = (e: KeyboardEvent) => { const tag = (e.target as HTMLElement).tagName; if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return; switch (e.key) { case ' ': case 'k': case 'K': e.preventDefault(); togglePlayback(); showControls(); break; case 'f': case 'F': e.preventDefault(); toggleFullscreen(); break; case 'm': case 'M': e.preventDefault(); toggleMute(); showControls(); break; case 'p': case 'P': e.preventDefault(); void togglePip(); break; case 'ArrowUp': { e.preventDefault(); const video = videoRef.current; if (video) { const newVol = Math.min(1, video.volume + 0.1); video.volume = newVol; setVolume(newVol); onVolumeChange?.(newVol); } showControls(); break; } case 'ArrowDown': { e.preventDefault(); const video = videoRef.current; if (video) { const newVol = Math.max(0, video.volume - 0.1); video.volume = newVol; setVolume(newVol); onVolumeChange?.(newVol); } showControls(); break; } case 'Escape': if (activePopup) { setActivePopup(null); showControls(); } else if (isPseudoFullscreen) exitPseudoFullscreen(); else if (document.fullscreenElement) void document.exitFullscreen(); break; } }; window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey); }, [status, togglePlayback, toggleFullscreen, toggleMute, togglePip, showControls, onVolumeChange, activePopup, isPseudoFullscreen, exitPseudoFullscreen]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || urls.length === 0) return;
    const el = video;
    let cancelled = false;
    let urlIndex = 0;
    let retries = 0;
    let networkRetries = 0;
    let started = false;
    let playbackInitiated = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    startupAtRef.current = performance.now();
    rebufferCountRef.current = 0;
    setStatus('loading'); setBuffering(false); setLevels([]); setActiveLevel(-1); setAutoplayBlocked(false); setRetrying(false); setLiveProgress(0); setLiveEdge(0); setBandwidth(null); setErrorInfo({ type: null, httpCode: null });
    setStats({ startupMs: null, rebufferCount: 0, bufferAhead: 0, bitrate: null, latency: null });
    const clearTimers = (): void => { if (deadlineTimer) clearTimeout(deadlineTimer); if (retryTimer) clearTimeout(retryTimer); deadlineTimer = retryTimer = null; };
    const destroy = (): void => { const hls = hlsRef.current; if (hls) { hls.stopLoad(); hls.detachMedia(); hls.destroy(); } hlsRef.current = null; el.removeAttribute('src'); el.load(); };
    const bufferAhead = (): number => el.buffered.length === 0 ? 0 : Math.max(0, el.buffered.end(el.buffered.length - 1) - el.currentTime);
    const updateStats = (latency: number | null = null): void => setStats((c) => ({ ...c, bufferAhead: bufferAhead(), latency }));
    const markReady = (): void => { if (cancelled) return; started = true; retries = 0; networkRetries = 0; setStatus('ready'); setBuffering(false); setRetrying(false); setStats((c) => ({ ...c, startupMs: c.startupMs ?? performance.now() - startupAtRef.current, rebufferCount: rebufferCountRef.current, bufferAhead: bufferAhead() })); if (deadlineTimer) clearTimeout(deadlineTimer); };
    const advance = (): void => { if (cancelled) return; retries += 1; setRetrying(true); if (retries <= MAX_RETRIES) { retryTimer = setTimeout(loadCurrent, exponentialDelay(retries)); return; } if (urlIndex + 1 < urls.length) { urlIndex += 1; retries = 0; networkRetries = 0; loadCurrent(); return; } setStatus('error'); setRetrying(false); };
    function loadCurrent(): void {
      if (cancelled) return;
      clearTimers(); destroy(); setStatus('loading'); setRetrying(false); setLevels([]); setActiveLevel(-1); startupAtRef.current = performance.now();
      if (!Hls.isSupported()) { el.src = urls[urlIndex]; el.load(); return; }
      started = false;
      playbackInitiated = false;
      const initiatePlayback = (): void => { if (playbackInitiated || cancelled) return; playbackInitiated = true; void el.play().catch(() => setAutoplayBlocked(true)); };
      deadlineTimer = setTimeout(() => { if (!cancelled && !started) { if (bufferAhead() >= MIN_VIABLE_BUFFER_SECONDS) { playbackInitiated = true; void el.play().catch(() => setAutoplayBlocked(true)); } else advance(); } }, STARTUP_DEADLINE_MS);
      const profile = networkProfile();
      startBufferRef.current = profile.startBuffer;
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false, startFragPrefetch: profile.capHeight === null, backBufferLength: 6, maxBufferLength: profile.buffer, maxMaxBufferLength: 45, maxBufferSize: 45 * 1000 * 1000, maxBufferHole: 0.5, liveSyncDurationCount: profile.liveSyncCount, liveMaxLatencyDurationCount: profile.liveSyncCount + 7, startLevel: 0, abrEwmaDefaultEstimate: profile.estimate, abrEwmaFastVoD: 2, abrEwmaSlowVoD: 5, abrBandWidthFactor: 0.7, abrBandWidthUpFactor: 0.5, abrMaxWithRealBitrate: true, capLevelToPlayerSize: true, maxLoadingDelay: 2, maxFragLookUpTolerance: 0.3, manifestLoadingTimeOut: 15_000, manifestLoadingMaxRetry: 3, levelLoadingTimeOut: 15_000, levelLoadingMaxRetry: 3, fragLoadingTimeOut: 20_000, fragLoadingMaxRetry: 4, maxStarvationDelay: 4 });
      hlsRef.current = hls; retryRef.current = loadCurrent; hls.loadSource(urls[urlIndex]); hls.attachMedia(el);
      hls.on(Hls.Events.ERROR, (_event, data: ErrorData) => {
        if (cancelled || !data.fatal) return;
        if (data.type === ErrorTypes.MEDIA_ERROR) { if (el.buffered.length > 0 && el.currentTime + 0.5 < el.buffered.end(el.buffered.length - 1)) el.currentTime += 0.5; hls.recoverMediaError(); return; }
        if (data.type === ErrorTypes.NETWORK_ERROR) {
          const code = data.response?.code ?? null; const master = typeof data.url === 'string' && data.url.includes('master.m3u8');
          if (code === 401 || code === 403 || (code === 404 && master)) { setErrorInfo({ type: 'networkError', httpCode: code }); if (urlIndex + 1 < urls.length) { urlIndex += 1; retries = 0; networkRetries = 0; loadCurrent(); } else setStatus('error'); return; }
          if ([Hls.ErrorDetails.MANIFEST_LOAD_ERROR, Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT, Hls.ErrorDetails.LEVEL_LOAD_ERROR, Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT].includes(data.details)) { setErrorInfo({ type: 'networkError', httpCode: code }); advance(); return; }
          networkRetries += 1; if (networkRetries <= MAX_NETWORK_RETRIES) { retryTimer = setTimeout(() => { if (!cancelled && hlsRef.current === hls) hls.startLoad(-1); }, Math.min(1000 * networkRetries, 4000)); return; }
        }
        setErrorInfo({ type: data.type, httpCode: null }); advance();
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (cancelled || hlsRef.current !== hls) return;
        const discovered = hls.levels.map((level, index) => ({ index, height: level.height || heightFromBitrate(level.bitrate), bitrate: level.bitrate }));
        setLevels(discovered);
        networkCapRef.current = profile.capHeight === null ? -1 : Math.max(0, ...discovered.filter((l) => l.height <= profile.capHeight!).map((l) => l.index));
        const dataCap = Math.max(0, ...discovered.filter((l) => l.height <= DATA_SAVER_MAX_HEIGHT).map((l) => l.index));
        hls.autoLevelCapping = initialDataSaver ? Math.min(networkCapRef.current < 0 ? dataCap : networkCapRef.current, dataCap) : networkCapRef.current;
        hls.currentLevel = initialLevel !== undefined && initialLevel >= 0 ? initialLevel : -1;
        if (bufferAhead() >= startBufferRef.current) initiatePlayback();
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => { if (!cancelled) { setActiveLevel(data.level); setStats((c) => ({ ...c, bitrate: hls.levels[data.level]?.bitrate ?? null })); } });
      hls.on(Hls.Events.LEVEL_UPDATED, (_event, data) => { const edge = data.details.live ? data.details.edge : null; updateStats(edge === null ? null : Math.max(0, edge - el.currentTime)); });
      hls.on(Hls.Events.FRAG_BUFFERED, () => { networkRetries = 0; setBandwidth(hls.bandwidthEstimate); updateStats(); if (!playbackInitiated && bufferAhead() >= startBufferRef.current) { playbackInitiated = true; void el.play().catch(() => setAutoplayBlocked(true)); } });
    }
    const onPlaying = (): void => markReady();
    const onCanPlay = (): void => { if (!Hls.isSupported()) markReady(); };
    const onWaiting = (): void => { if (started) { rebufferCountRef.current += 1; setStats((c) => ({ ...c, rebufferCount: rebufferCountRef.current })); } const hls = hlsRef.current; if (hls && selectedLevelRef.current === -1) { hls.nextAutoLevel = 0; hls.startLoad(-1); } setBuffering(true); };
    const onPlayingReset = (): void => { if (started) { const hls = hlsRef.current; if (hls && selectedLevelRef.current === -1) hls.nextAutoLevel = -1; setBuffering(false); updateStats(); } };
    const onError = (): void => advance();
    el.addEventListener('playing', onPlaying); el.addEventListener('canplay', onCanPlay); el.addEventListener('waiting', onWaiting); el.addEventListener('playing', onPlayingReset); el.addEventListener('error', onError);
    if (Hls.isSupported()) loadCurrent(); else if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = urls[urlIndex]; video.load(); } else setStatus('error');
    return () => { cancelled = true; retryRef.current = null; clearTimers(); destroy(); el.removeEventListener('playing', onPlaying); el.removeEventListener('canplay', onCanPlay); el.removeEventListener('waiting', onWaiting); el.removeEventListener('playing', onPlayingReset); el.removeEventListener('error', onError); };
  }, [urlsKey]);

  const activeHeight = levels.find((l) => l.index === activeLevel)?.height;
  const qualityLabel = selectedLevel === -1 ? `Auto${activeHeight ? ` · ${activeHeight}p` : ''}` : `${levels.find((l) => l.index === selectedLevel)?.height ?? 'Auto'}p`;
  const retry = (): void => { retryRef.current?.(); };
  useEffect(() => { const hls = hlsRef.current; if (!hls || levels.length === 0) return; const dataCap = Math.max(0, ...levels.filter((l) => l.height <= DATA_SAVER_MAX_HEIGHT).map((l) => l.index)); hls.autoLevelCapping = dataSaver ? Math.min(networkCapRef.current < 0 ? dataCap : networkCapRef.current, dataCap) : networkCapRef.current; hls.currentLevel = dataSaver ? -1 : selectedLevel; }, [dataSaver, selectedLevel, levels]);
  useEffect(() => { const video = videoRef.current; if (!video || initialVolume === undefined) return; video.volume = initialVolume; setVolume(initialVolume); const onVol = (): void => { setVolume(video.volume); onVolumeChange?.(video.volume); }; video.addEventListener('volumechange', onVol); return () => video.removeEventListener('volumechange', onVol); }, [initialVolume, onVolumeChange]);

  const VolumeIcon = muted || volume === 0 ? Icon.VolumeX : volume < 0.5 ? Icon.Volume1 : Icon.Volume2;
  const errorMsg = status === 'error' ? getErrorMessage(errorInfo.type, errorInfo.httpCode) : '';
  const net = getNetworkInfo();
  const isIos = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);

  return <div ref={containerRef} className={`${styles.player} ${controlsVisible ? styles.controlsVisible : ''} ${isMobile ? styles.mobile : ''} ${isPseudoFullscreen ? styles.pseudoFullscreen : ''}`} data-state={status} onMouseMove={!isMobile ? showControls : undefined} onMouseLeave={() => { if (!isMobile && status === 'ready') setControlsVisible(false); }} onTouchStart={(e) => { showControls(); handleTouchStart(e); }} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
    <video ref={videoRef} className={styles.video} playsInline preload="auto" onClick={handleVideoClick} aria-label={`Lecteur ${title}`} />
    {status !== 'ready' && <div className={styles.overlay} role="status" aria-live="polite"><div className={styles.signal}><span className={styles.signalDot} /><span>{retrying ? 'Reconnexion au flux…' : status === 'error' ? 'Flux indisponible' : 'Connexion au direct'}</span></div>{status === 'loading' && <><Spinner /><p className={styles.hint}>{retrying ? 'Nouvelle tentative…' : <>Préchargement du direct : <strong>{formatBuffer(stats.bufferAhead)}</strong> / {startBufferRef.current} s en mémoire tampon avant le lancement.</>}</p></>}{status === 'error' && <><h2 className={styles.title}>Lecture interrompue</h2><p className={styles.hint}>{errorMsg}</p><div className={styles.errorMeta}><span className={styles.errorTag}>Réseau : {net.effectiveType}{net.downlink > 0 ? ` · ${net.downlink} Mbps` : ''}</span>{net.saveData && <span className={styles.errorTag}>Mode économie activé</span>}</div><button type="button" className={styles.retryButton} onClick={retry}>Réessayer</button></>}</div>}
    {status === 'ready' && buffering && <div className={styles.bufferingOverlay} role="status" aria-label="Mise en mémoire tampon"><Spinner /><span>Rattrapage du direct…</span></div>}
    {bandwidth !== null && <div className={styles.bandwidthBadge} role="status" aria-label="Débit réseau en temps réel"><Icon.Activity size={13} aria-hidden /><span>{formatBitrate(bandwidth)}</span></div>}
    {status === 'ready' && autoplayBlocked && <button type="button" className={styles.playPrompt} onClick={() => { const video = videoRef.current; if (video) void video.play().then(() => setAutoplayBlocked(false)).catch(() => undefined); }}>Lancer la lecture</button>}
    {gestureOverlay && <div className={styles.gestureOverlay} role="status" aria-live="polite"><span className={styles.gestureIcon}>{gestureOverlay.type === 'volume' ? <Icon.Volume2 size={28} /> : <Icon.Maximize size={28} />}</span><span className={styles.gestureValue}>{gestureOverlay.value}%</span></div>}
    {status === 'ready' && <div className={styles.progressBar}><div className={styles.progressFill} style={{ width: `${liveProgress}%` }} /></div>}
    {status === 'ready' && !isMobile && <div className={styles.controlRail} aria-label="Contrôles du lecteur"><span className={styles.liveBadge}>DIRECT</span><span className={styles.stat}>Qualité {qualityLabel}</span><span className={styles.statWrap}><span className={styles.statHint}>Buffer {formatBuffer(stats.bufferAhead)}</span><span className={styles.statTooltip}>Secondes de vidéo en mémoire tampon</span></span><span className={styles.statWrap}><span className={styles.statHint}>Démarrage {formatDuration(stats.startupMs)}</span><span className={styles.statTooltip}>Temps de chargement initial</span></span>{stats.rebufferCount > 0 && <span className={styles.statWarning}>Rebuffers {stats.rebufferCount}</span>}<div className={styles.volumeControl}><button type="button" className={styles.iconBtn} onClick={toggleMute} aria-label={muted ? 'Activer le son' : 'Couper le son'}><VolumeIcon size={16} /></button><input type="range" className={styles.volumeSlider} min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={handleVolumeChange} aria-label="Volume" /></div><select className={styles.qualitySelect} value={dataSaver ? -1 : selectedLevel} aria-label="Qualité vidéo" onChange={(e) => { const level = Number(e.target.value); setSelectedLevel(level); onLevelChange?.(level); }}><option value={-1}>Auto{activeHeight ? ` — ${activeHeight}p` : ''}</option>{levels.map((level) => <option key={level.index} value={level.index}>{level.height}p — {formatBitrate(level.bitrate)}</option>)}</select><label className={styles.dataSaverToggle}><input type="checkbox" checked={dataSaver} onChange={(e) => { setDataSaver(e.target.checked); onDataSaverChange?.(e.target.checked); }} />Éco</label>{pipSupported && <button type="button" className={styles.iconBtn} onClick={() => void togglePip()} aria-label={isPip ? 'Quitter le mini-player' : 'Mini-player'}><Icon.Monitor size={16} /></button>}{fsSupported && <button type="button" className={styles.iconBtn} onClick={toggleFullscreen} aria-label={isFullscreen || isPseudoFullscreen ? 'Quitter le plein écran' : 'Plein écran'}>{isFullscreen || isPseudoFullscreen ? <Icon.Minimize size={16} /> : <Icon.Maximize size={16} />}</button>}</div>}
    {status === 'ready' && isMobile && <div className={styles.mobileTopBar}><span className={styles.liveBadge}>DIRECT</span><span className={styles.mobileQualityLabel}>{qualityLabel}</span></div>}
    {status === 'ready' && isMobile && <div className={styles.mobileBottomBar} aria-label="Contrôles du lecteur"><button type="button" className={styles.mobileIconBtn} onClick={toggleMute} aria-label={muted ? 'Activer le son' : 'Couper le son'}><VolumeIcon size={20} /></button><button type="button" className={`${styles.mobileIconBtn} ${activePopup === 'quality' ? styles.mobileIconBtnActive : ''}`} onClick={() => setActivePopup(activePopup === 'quality' ? null : 'quality')} aria-label="Qualité vidéo"><Icon.Settings2 size={20} /></button><label className={styles.mobileIconBtn}><input type="checkbox" checked={dataSaver} onChange={(e) => { setDataSaver(e.target.checked); onDataSaverChange?.(e.target.checked); }} className={styles.mobileCheckbox} /><span className={dataSaver ? styles.mobileEcoActive : ''}>Éco</span></label>{pipSupported && <button type="button" className={styles.mobileIconBtn} onClick={() => void togglePip()} aria-label={isPip ? 'Quitter le mini-player' : 'Mini-player'}><Icon.Monitor size={20} /></button>}{fsSupported && <button type="button" className={styles.mobileIconBtn} onClick={toggleFullscreen} aria-label={isFullscreen || isPseudoFullscreen ? 'Quitter le plein écran' : 'Plein écran'}>{isFullscreen || isPseudoFullscreen ? <Icon.Minimize size={20} /> : <Icon.Maximize size={20} />}</button>}</div>}
    {isMobile && activePopup && <div className={styles.popupBackdrop} onClick={closePopup} />}
    {isMobile && activePopup === 'quality' && <div className={styles.mobilePopup} role="dialog" aria-label="Choisir la qualité"><div className={styles.popupHeader}><span className={styles.popupTitle}>Qualité vidéo</span><button type="button" className={styles.popupClose} onClick={closePopup} aria-label="Fermer"><Icon.X size={18} /></button></div><div className={styles.popupOptions}><button type="button" className={`${styles.popupOption} ${selectedLevel === -1 && !dataSaver ? styles.popupOptionActive : ''}`} onClick={() => { setSelectedLevel(-1); onLevelChange?.(-1); closePopup(); }}><span>Auto{activeHeight ? ` — ${activeHeight}p` : ''}</span>{selectedLevel === -1 && !dataSaver && <Icon.Check size={16} />}</button>{levels.map((level) => <button key={level.index} type="button" className={`${styles.popupOption} ${selectedLevel === level.index ? styles.popupOptionActive : ''}`} onClick={() => { setSelectedLevel(level.index); onLevelChange?.(level.index); closePopup(); }}><span className={styles.popupOptionLeft}><span>{level.height}p</span>{level.bitrate && <span className={styles.bitrateBadge}>{formatBitrate(level.bitrate)}</span>}</span>{selectedLevel === level.index && <Icon.Check size={16} />}</button>)}</div></div>}
    {isMobile && activePopup === 'volume' && <div className={styles.mobilePopup} role="dialog" aria-label="Volume"><div className={styles.popupHeader}><span className={styles.popupTitle}>Volume</span><button type="button" className={styles.popupClose} onClick={closePopup} aria-label="Fermer"><Icon.X size={18} /></button></div><div className={styles.popupVolumeContent}>{isIos ? <p className={styles.popupVolumeHint}>Sur iOS, le volume se contrôle via les boutons physiques de l'appareil.</p> : <div className={styles.popupVolumeSlider}><button type="button" className={styles.iconBtn} onClick={toggleMute} aria-label={muted ? 'Activer le son' : 'Couper le son'}><VolumeIcon size={20} /></button><input type="range" className={styles.volumeSliderLarge} min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={handleVolumeChange} aria-label="Volume" /><span className={styles.volumePercent}>{muted ? 0 : Math.round(volume * 100)}%</span></div>}</div></div>}
  </div>;
}
