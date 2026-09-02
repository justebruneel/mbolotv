'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls, { ErrorTypes } from 'hls.js';
import type { ErrorData } from 'hls.js';
import type MpegtsPlayer from 'mpegts.js';
import { Spinner } from '../Spinner/Spinner';
import { Icon } from '../icons';
import styles from './Player.module.css';

export interface PlayerProps { urls: string[]; title: string; initialVolume?: number; initialLevel?: number; initialDataSaver?: boolean; autoPlay?: boolean; onVolumeChange?: (volume: number) => void; onLevelChange?: (level: number) => void; onDataSaverChange?: (enabled: boolean) => void; onRefreshSource?: () => Promise<boolean>; }
interface QualityLevel { index: number; height: number; bitrate?: number; }
interface PlaybackStats { startupMs: number | null; rebufferCount: number; bufferAhead: number; bitrate: number | null; latency: number | null; }
interface GestureState { startX: number; startY: number; startTime: number; }
interface NetworkInformationLike { effectiveType?: string; downlink?: number; saveData?: boolean; addEventListener?: (type: string, listener: () => void) => void; removeEventListener?: (type: string, listener: () => void) => void; }

const MAX_RETRIES = 2;
const MAX_NETWORK_RETRIES = 3;
// Erreurs fatales manifest/level : on retente hls.startLoad (léger, ne détruit
// pas le player) avec backoff 500 ms → 1 s → 2 s AVANT le reload destructeur
// de advance() — la majorité de ces erreurs sont des à-coups réseau passagers.
const MAX_LEVEL_RETRIES = 3;
const LEVEL_RETRY_BASE_MS = 500;
// Fast-start : affichage quasi instantané dès la connexion au flux.
// 1) On démarre sur le niveau de qualité LE PLUS BAS de la chaîne (équivalent
//    startLevel: 0, calculé sur les vrais niveaux du manifest) au lieu de
//    laisser l'ABR choisir dès le premier segment.
// 2) Après FAST_START_STABLE_MS de lecture SANS rebuffer, l'ABR reprend la
//    main normalement (currentLevel = -1) et monte en qualité selon la bande
//    passante réellement mesurée — les fragments basse qualité téléchargés
//    pendant la fenêtre alimentent l'EWMA, donc pas besoin du warmup cap.
// 3) Le buffer de démarrage est réduit à UN SEUL SEGMENT téléchargé (voir
//    startupBufferTarget) au lieu du matelas de 5-6 s du chantier buffer.
// 4) UN SEUL MODE « Auto » : un choix qualité explicite de l'utilisateur est
//    respecté dès le départ (pas de fast-start).
//
// LIMITATION VARIANTES (dépend du fournisseur, pas de ce lecteur) : le système
// est un pass-through (hls-rewriter.ts + proxy edge préservent TOUTES les
// variantes du master ; seul le paramètre maxh du mode Éco filtre). Les
// fournisseurs typiques exposent 3-5 variantes (240p → 1080p+) et le lecteur
// les détecte via hls.levels dans MANIFEST_PARSED (menu qualité affiché si
// levels.length > 1). MAIS : en mode Éco, l'eco-transcoder (tools/
// eco-transcoder, 480p ~1 Mbps) produit une sortie MONO-VARIANTE, et certains
// flux fournisseurs sont des media playlists directes sans
// #EXT-X-STREAM-INF. Dans ces cas, « démarrer au plus bas » = le seul niveau
// disponible : le fast-start n'a d'effet réel que sur le buffer de démarrage
// réduit, pas sur la qualité initiale.
const FAST_START_STABLE_MS = 6_000;
// Borne haute du buffer de démarrage fast-start : un segment de panel peut
// durer 10 s — au-delà de 4 s d'avance, on lance l'affichage sans attendre.
const FAST_START_MAX_BUFFER_SECONDS = 4;
const DATA_SAVER_MAX_HEIGHT = 480;
const STARTUP_DEADLINE_MS = 15_000;
const MIN_VIABLE_BUFFER_SECONDS = 2;
const RESUME_BUFFER_SECONDS = 3;
const STALL_PAUSE_THRESHOLD_SECONDS = 0.5;
// Anti-overshoot au démarrage : les premiers fragments arrivent sur une
// connexion déjà chaude (warmStream + caches fournisseur) et gonflent
// l'estimation EWMA — l'ABR monte alors sur un niveau que le débit réel ne
// soutient pas, le buffer se vide, la lecture « rattrape » le préchargé puis
// se bloque pour recharger. Pendant cette fenêtre, on plafonne l'ABR au
// niveau le plus haut dont le bitrate tient dans l'estimation conservative
// du profil réseau ; passé le délai, l'ABR reprend la main avec un buffer
// déjà fourni et se corrige sans stall.
const START_WARMUP_MS = 12_000;
// Seuil de démarrage : 1,5× la durée d'un segment, borné. Avec des segments
// de 6-10 s, partir avec 2-3 s d'avance garantit un rattrapage au premier
// fragment lent ; attendre le premier fragment complet évite ce piège.
const START_BUFFER_MAX_SECONDS = 6;
const CONTROLS_HIDE_DELAY_MS = 3_000;
const MOBILE_CONTROLS_HIDE_DELAY_MS = 4_000;
const GESTURE_THRESHOLD = 40;
// Fenêtre de la jauge de latence : au-delà de 60 s derrière le direct, la
// barre est considérée vide (valeur d'affichage, pas un seuil de correction).
const LIVE_LATENCY_WINDOW_SECONDS = 60;
// Les valeurs < 10 dans le store hérité sont d'anciens INDEX de niveau (pas
// des hauteurs) : interprétées comme « Auto ». Les nouvelles valeurs sont
// des hauteurs cibles en pixels (ex. 1080).
const LEGACY_LEVEL_INDEX_MAX = 10;

function exponentialDelay(attempt: number): number { return Math.min(1000 * 2 ** attempt, 8000); }
/** Backoff léger pour les retries de niveau : 500 ms → 1 s → 2 s → … */
function levelRetryDelay(attempt: number): number { return LEVEL_RETRY_BASE_MS * 2 ** (attempt - 1); }
function formatBitrate(bps: number | undefined): string { if (!bps) return ''; if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`; return `${Math.round(bps / 1000)} kbps`; }
function heightFromBitrate(bps: number | undefined): number { if (!bps) return 0; if (bps < 500_000) return 360; if (bps < 1_500_000) return 480; if (bps < 3_500_000) return 720; if (bps < 6_000_000) return 1080; return 1440; }
/** Durée cible d'un segment telle que publiée par la playlist (0 si inconnue). */
function targetDurationOf(details: unknown): number {
  const d = details as { targetduration?: number; averagetargetduration?: number; fragments?: Array<{ duration?: number }> } | null | undefined;
  return d?.targetduration || d?.averagetargetduration || d?.fragments?.[0]?.duration || 0;
}
function formatDuration(ms: number | null): string { return ms === null ? '…' : `${(ms / 1000).toFixed(1)} s`; }
function formatBuffer(seconds: number): string { return `${Math.max(0, seconds).toFixed(1)} s`; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
/** Index du niveau le plus haut ≤ hauteur demandée (le plus bas si la demande est sous le min) ; -1 = Auto. */
function resolveHeightIndex(levels: QualityLevel[], height: number): number {
  if (height < 0 || levels.length === 0) return -1;
  const sorted = [...levels].sort((a, b) => a.height - b.height);
  const below = sorted.filter((l) => l.height <= height);
  return below.length > 0 ? below[below.length - 1].index : sorted[0].index;
}
function networkProfile(): { estimate: number; capHeight: number | null; buffer: number; liveSyncSeconds: number; liveMaxLatencySeconds: number; startBuffer: number } {
  const conn = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  const type = conn?.effectiveType;
  const downlink = conn?.downlink ?? 0;
  // Priorité STABILITÉ sur latence (TV classique, 15-20 s de retard acceptables).
  // Réglage EN SECONDES (liveSyncDuration) et non en nombre de segments : les
  // panels servent des segments de 2 à 10 s — un compte fixe donnerait 10 s
  // de retard sur du 2 s et 2 min sur du 10 s. 20-24 s derrière le live edge
  // = matelas de protection ; liveMaxLatency ≈ 2× déclenche la resynchronisation.
  if (conn?.saveData || type === 'slow-2g' || type === '2g' || (downlink > 0 && downlink < 1)) return { estimate: 350_000, capHeight: 360, buffer: 40, liveSyncSeconds: 24, liveMaxLatencySeconds: 45, startBuffer: 6 };
  if (type === '3g' || (downlink > 0 && downlink < 3)) return { estimate: 750_000, capHeight: 720, buffer: 50, liveSyncSeconds: 22, liveMaxLatencySeconds: 42, startBuffer: 6 };
  return { estimate: 1_200_000, capHeight: null, buffer: 60, liveSyncSeconds: 20, liveMaxLatencySeconds: 40, startBuffer: 5 };
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

export function Player({ urls, title, initialVolume, initialLevel, initialDataSaver, autoPlay = true, onVolumeChange, onLevelChange, onDataSaverChange, onRefreshSource }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  // Flux MPEG-TS bruts (portails Stalker) : lus par mpegts.js (MSE) — hls.js
  // n'accepte qu'un manifest .m3u8 et bouclerait en erreur sur un TS direct.
  // Import dynamique : le paquet touche `self` au top-level (SSR interdit).
  const mpegtsRef = useRef<ReturnType<typeof MpegtsPlayer.createPlayer> | null>(null);
  // mpegts.js chargé par script dynamique (l'import webpack crée un chunk 404
  // sur Vercel → la promesse pend sans résoudre, spinner infini).
  const mpegtsReadyRef = useRef<Promise<typeof MpegtsPlayer | null> | null>(null);
  const loadMpegts = useCallback(async (): Promise<typeof MpegtsPlayer | null> => {
    if (mpegtsReadyRef.current) return mpegtsReadyRef.current;
    if (typeof window === 'undefined') return null;
    if ((window as unknown as Record<string, unknown>).mpegts) return (window as unknown as Record<string, unknown>).mpegts as typeof MpegtsPlayer;
    mpegtsReadyRef.current = new Promise<typeof MpegtsPlayer | null>((resolve) => {
      const s = document.createElement('script');
      s.src = '/mpegts.min.js';
      s.crossOrigin = 'anonymous';
      s.onload = () => resolve((window as unknown as Record<string, unknown>).mpegts as typeof MpegtsPlayer | null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
    return mpegtsReadyRef.current;
  }, []);
  const retryRef = useRef<(() => void) | null>(null);
  const networkCapRef = useRef(-1);
  // Fast-start : actif + timer de libération ABR en refs pour que l'effet
  // qualité (un choix manuel hors Auto) puisse annuler la libération
  // programmée depuis l'extérieur de la closure du chargement.
  const fastStartActiveRef = useRef(false);
  const fastStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startupAtRef = useRef(0);
  const rebufferCountRef = useRef(0);
  // Journal de session (tâche 5) : rebuffer/erreurs/retries horodatés —
  // déversé en console au démontage pour mesurer l'effet des réglages en prod
  // (grep "[player-session]" dans les logs navigateur).
  const sessionLogRef = useRef<Array<{ ts: number; type: string; detail: string }>>([]);
  const sessionStartRef = useRef(0);
  const logSession = useCallback((type: string, detail: string): void => {
    sessionLogRef.current.push({ ts: Date.now() - sessionStartRef.current, type, detail });
  }, []);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureRef = useRef<GestureState | null>(null);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [buffering, setBuffering] = useState(false);
  const [levels, setLevels] = useState<QualityLevel[]>([]);
  const [activeLevel, setActiveLevel] = useState(-1);
  // Qualité persistée en HAUTEUR cible (ex. 1080) résolue par flux au
  // manifest — l'ancien stockage par index suivait le mauvais niveau d'une
  // chaîne à l'autre (les index ne sont pas stables entre playlists).
  const [selectedHeight, setSelectedHeight] = useState<number>(() => (initialLevel !== undefined && initialLevel >= LEGACY_LEVEL_INDEX_MAX ? initialLevel : -1));
  const preferredHeight = initialLevel !== undefined && initialLevel >= LEGACY_LEVEL_INDEX_MAX ? initialLevel : -1;
  const resolvedIndex = useMemo(() => resolveHeightIndex(levels, selectedHeight), [levels, selectedHeight]);
  const [dataSaver, setDataSaver] = useState(initialDataSaver ?? false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  // Lecture démarrée en muet après un refus d'autoplay (politique navigateur) :
  // on propose ensuite à l'utilisateur de réactiver le son.
  const [mutedAutoplay, setMutedAutoplay] = useState(false);
  const [isPaused, setIsPaused] = useState(true);
  const [stats, setStats] = useState<PlaybackStats>({ startupMs: null, rebufferCount: 0, bufferAhead: 0, bitrate: null, latency: null });
  const [retrying, setRetrying] = useState(false);
  const [errorInfo, setErrorInfo] = useState<{ type: string | null; httpCode: number | null }>({ type: null, httpCode: null });
  const [volume, setVolume] = useState(initialVolume ?? 1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isPip, setIsPip] = useState(false);
  const [liveProgress, setLiveProgress] = useState(0);
  const [bandwidth, setBandwidth] = useState<number | null>(null);
  const [gestureOverlay, setGestureOverlay] = useState<{ type: 'volume'; value: number } | null>(null);
  const gestureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [activePopup, setActivePopup] = useState<'volume' | 'quality' | null>(null);
  const [pipSupported, setPipSupported] = useState(true);
  const [fsSupported, setFsSupported] = useState(true);
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false);
  const isIosRef = useRef(false);
  const startBufferRef = useRef(2);
  // Timestamp du dernier avancement de currentTime : détecte les flux TS
  // « morts » (segment panel consommé) qui se figent sans émettre d'erreur.
  const lastProgressRef = useRef(0);
  const deadSinceRef = useRef(0);
  const refreshingRef = useRef(false);
  // Durée d'un segment du flux courant (LEVEL_UPDATED) : sert à caler le
  // seuil de démarrage sur la granularité réelle du flux.
  const fragDurationRef = useRef(0);
  const stallPauseRef = useRef(false);
  const liveEdgeRef = useRef(0);
  const urlsRef = useRef(urls);
  urlsRef.current = urls;
  const urlsKey = useMemo(() => urls.join('\n'), [urls]);

  useEffect(() => {
    const mq = window.matchMedia('(hover: none) and (pointer: coarse)');
    const check = () => { const mobile = mq.matches || navigator.maxTouchPoints > 0; setIsMobile(mobile); isIosRef.current = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); };
    check(); mq.addEventListener('change', check); return () => mq.removeEventListener('change', check);
  }, []);
  useEffect(() => { setPipSupported(document.pictureInPictureEnabled); const el = containerRef.current; const hasNativeFs = Boolean(el && ('requestFullscreen' in el || 'webkitRequestFullscreen' in el)); const hasWebkitFs = typeof document !== 'undefined' && 'webkitEnterFullscreen' in HTMLVideoElement.prototype; setFsSupported(hasNativeFs || hasWebkitFs || isMobile); }, [isMobile]);
  const hideDelay = isMobile ? MOBILE_CONTROLS_HIDE_DELAY_MS : CONTROLS_HIDE_DELAY_MS;
  const showControls = useCallback(() => { setControlsVisible(true); if (hideTimerRef.current) clearTimeout(hideTimerRef.current); hideTimerRef.current = setTimeout(() => setControlsVisible(false), hideDelay); }, [hideDelay]);
  useEffect(() => {
    if (status !== 'ready') {
      setControlsVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      return;
    }
    // Dès le passage en lecture, les contrôles se masquent seuls après le
    // délai — sans attendre un premier mouvement de souris ou de toucher.
    showControls();
  }, [status, showControls]);
  useEffect(() => { const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement)); document.addEventListener('fullscreenchange', onFsChange); return () => document.removeEventListener('fullscreenchange', onFsChange); }, []);
  const exitPseudoFullscreen = useCallback(() => { setIsPseudoFullscreen(false); document.body.style.overflow = ''; }, []);
  useEffect(() => { const video = videoRef.current; if (!video) return; const onEnterPiP = () => setIsPip(true); const onLeavePiP = () => setIsPip(false); video.addEventListener('enterpictureinpicture', onEnterPiP); video.addEventListener('leavepictureinpicture', onLeavePiP); return () => { video.removeEventListener('enterpictureinpicture', onEnterPiP); video.removeEventListener('leavepictureinpicture', onLeavePiP); }; }, []);
  useEffect(() => { const video = videoRef.current; if (!video) return; const syncPaused = (): void => setIsPaused(video.paused); syncPaused(); video.addEventListener('play', syncPaused); video.addEventListener('pause', syncPaused); return () => { video.removeEventListener('play', syncPaused); video.removeEventListener('pause', syncPaused); }; }, []);
  // Si le composant démonte pendant le pseudo-plein écran, ne pas laisser le
  // scroll du body verrouillé.
  useEffect(() => () => { document.body.style.overflow = ''; }, []);
  // Progression live + stats buffer : un tick de 500 ms suffit largement (un
  // rAF re-rendererait tout le player ~60×/s pour des valeurs quasi statiques).
  useEffect(() => {
    if (status !== 'ready') return;
    const video = videoRef.current;
    if (!video) return;
    const tick = (): void => {
      if (video.buffered.length === 0) return;
      const bufferedEnd = video.buffered.end(video.buffered.length - 1);
      const ahead = Math.max(0, bufferedEnd - video.currentTime);
      const edge = Math.max(liveEdgeRef.current, bufferedEnd);
      liveEdgeRef.current = edge;
      // Jauge de latence au direct : pleine = collé au edge, se vide quand on
      // prend du retard (la pseudo-progression currentTime/edge restait
      // figée ~100 % sur des flux sans DVR).
      const latency = Math.max(0, edge - video.currentTime);
      setLiveProgress(clamp((1 - latency / LIVE_LATENCY_WINDOW_SECONDS) * 100, 0, 100));
      setStats((c) => (c.bufferAhead === ahead && c.latency === latency ? c : { ...c, bufferAhead: ahead, latency }));
      // Chien de garde flux TS « mort » : les panels envoient des segments
      // finis — une fois consommé, la vidéo se fige (stall natif = paused,
      // buffer vide) sans qu'aucune erreur mpegts ne soit émise. Si le temps
      // ne progresse plus depuis 8 s avec un buffer vide, on force un
      // rafraîchissement de l'URL. Une pause utilisateur garde le buffer
      // plein (ahead >= 1) : elle ne déclenche jamais le refresh.
      if (mpegtsRef.current) {
        if (video.currentTime > lastProgressRef.current + 0.1) {
          lastProgressRef.current = video.currentTime;
          deadSinceRef.current = 0;
        } else if (ahead < 1) {
          if (deadSinceRef.current === 0) deadSinceRef.current = Date.now();
          if (Date.now() - deadSinceRef.current > 8000 && !refreshingRef.current) {
            refreshingRef.current = true;
            console.warn('[player] flux TS figé — rafraîchissement de l\'URL');
            void onRefreshSource?.().finally(() => { refreshingRef.current = false; });
          }
        } else {
          deadSinceRef.current = 0;
        }
      }
    };
    const interval = setInterval(tick, 500);
    return () => clearInterval(interval);
  }, [status]);
  // Onglet/appareil en arrière-plan : on stoppe le chargement des segments
  // (le buffer se fige, zéro bande passante gaspillée) et on reprend au
  // retour — hls.js se resynchronise au live edge de lui-même.
  useEffect(() => {
    const onVisibility = (): void => {
      const hls = hlsRef.current;
      if (!hls) return;
      if (document.hidden) hls.pauseBuffering();
      else hls.resumeBuffering();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  const toggleMute = useCallback(() => { const video = videoRef.current; if (!video) return; video.muted = !video.muted; setMuted(video.muted); }, []);
  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => { const video = videoRef.current; if (!video) return; const v = Number(e.target.value); video.volume = v; video.muted = v === 0; setVolume(v); setMuted(v === 0); onVolumeChange?.(v); }, [onVolumeChange]);
  const toggleFullscreen = useCallback(() => { const video = videoRef.current; const el = containerRef.current; if (!video || !el) return; if (document.fullscreenElement || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement) { const exitFn = document.exitFullscreen || (document as Document & { webkitExitFullscreen?: () => Promise<void> }).webkitExitFullscreen; if (exitFn) void exitFn.call(document); return; } if (isPseudoFullscreen) { exitPseudoFullscreen(); return; } if (isIosRef.current && 'webkitEnterFullscreen' in video) { void (video as HTMLVideoElement & { webkitEnterFullscreen: () => void }).webkitEnterFullscreen(); return; } const fsFn = el.requestFullscreen || (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen; if (fsFn) void fsFn.call(el).catch(() => { setIsPseudoFullscreen(true); document.body.style.overflow = 'hidden'; }); else { setIsPseudoFullscreen(true); document.body.style.overflow = 'hidden'; } }, [isPseudoFullscreen, exitPseudoFullscreen]);
  const togglePip = useCallback(async () => { const video = videoRef.current; if (!video) return; try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else if (document.pictureInPictureEnabled) await video.requestPictureInPicture(); } catch { /* PiP non disponible */ } }, []);
  const togglePlayback = useCallback(() => { const video = videoRef.current; if (!video || status !== 'ready') return; if (video.paused) { stallPauseRef.current = false; void video.play().catch(() => setAutoplayBlocked(true)); } else video.pause(); }, [status]);
  // Démarrage explicite demandé depuis les prompts (autoplay bloqué / son coupé).
  const startPlayback = useCallback((): void => {
    const video = videoRef.current;
    if (!video) return;
    if (mutedAutoplay) { video.muted = false; setMuted(false); setMutedAutoplay(false); }
    if (video.paused) { stallPauseRef.current = false; void video.play().then(() => setAutoplayBlocked(false)).catch(() => setAutoplayBlocked(true)); }
    else setAutoplayBlocked(false);
  }, [mutedAutoplay]);
  const handleVideoClick = useCallback(() => { if (isMobile) { if (controlsVisible) { setControlsVisible(false); setActivePopup(null); } else showControls(); } else togglePlayback(); }, [isMobile, controlsVisible, showControls, togglePlayback]);
  const closePopup = useCallback(() => { setActivePopup(null); showControls(); }, [showControls]);
  const handleTouchStart = useCallback((e: React.TouchEvent) => { if (status !== 'ready') return; const touch = e.touches[0]; gestureRef.current = { startX: touch.clientX, startY: touch.clientY, startTime: Date.now() }; }, [status]);
  const handleTouchMove = useCallback((e: React.TouchEvent) => { if (status !== 'ready' || !gestureRef.current || !containerRef.current) return; const touch = e.touches[0]; const rect = containerRef.current.getBoundingClientRect(); const dx = touch.clientX - gestureRef.current.startX; const dy = touch.clientY - gestureRef.current.startY; const absDx = Math.abs(dx); const absDy = Math.abs(dy); if (absDx < GESTURE_THRESHOLD / 2 && absDy < GESTURE_THRESHOLD / 2) return; // Volume vertical uniquement : pas de seek tactile (pas de DVR garanti sur
  // les flux IPTV) et iOS ignore video.volume (contrôle physique uniquement).
  if (absDx > absDy || isIosRef.current) return; const video = videoRef.current; if (!video) return; const ratio = clamp(-dy / rect.height, -0.5, 0.5); const newVol = clamp(video.volume + ratio, 0, 1); video.volume = newVol; video.muted = newVol === 0; setVolume(newVol); setMuted(newVol === 0); onVolumeChange?.(newVol); setGestureOverlay({ type: 'volume', value: Math.round(newVol * 100) }); }, [status, onVolumeChange]);
  const handleTouchEnd = useCallback(() => { gestureRef.current = null; if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current); gestureTimerRef.current = setTimeout(() => setGestureOverlay(null), 600); }, []);
  useEffect(() => { if (status !== 'ready') return; const handleKey = (e: KeyboardEvent) => { const tag = (e.target as HTMLElement).tagName; if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return; switch (e.key) { case ' ': case 'k': case 'K': e.preventDefault(); togglePlayback(); showControls(); break; case 'f': case 'F': e.preventDefault(); toggleFullscreen(); break; case 'm': case 'M': e.preventDefault(); toggleMute(); showControls(); break; case 'p': case 'P': e.preventDefault(); void togglePip(); break; case 'ArrowUp': { e.preventDefault(); const video = videoRef.current; if (video) { const newVol = Math.min(1, video.volume + 0.1); video.volume = newVol; if (newVol > 0) { video.muted = false; setMuted(false); } setVolume(newVol); onVolumeChange?.(newVol); } showControls(); break; } case 'ArrowDown': { e.preventDefault(); const video = videoRef.current; if (video) { const newVol = Math.max(0, video.volume - 0.1); video.volume = newVol; if (newVol > 0) { video.muted = false; setMuted(false); } setVolume(newVol); onVolumeChange?.(newVol); } showControls(); break; } case 'Escape': if (activePopup) { setActivePopup(null); showControls(); } else if (isPseudoFullscreen) exitPseudoFullscreen(); else if (document.fullscreenElement) void document.exitFullscreen(); break; } }; window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey); }, [status, togglePlayback, toggleFullscreen, toggleMute, togglePip, showControls, onVolumeChange, activePopup, isPseudoFullscreen, exitPseudoFullscreen]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || urls.length === 0) return;
    const el = video;
    let cancelled = false;
    let urlIndex = 0;
    let retries = 0;
    let networkRetries = 0;
    let levelRetries = 0;
    let started = false;
    let playbackInitiated = false;
    let mediaRecoveries = 0;
    let refreshUsed = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let warmupTimer: ReturnType<typeof setTimeout> | null = null;
    // Fast-start : un rebuffer pendant la fenêtre de stabilité repousse la
    // libération ABR (la fenêtre de 6 s repart de zéro, voir markReady).
    let fastStartRebuffered = false;
    // Sonde de démarrage mpegts : attend un vrai matelas de buffer avant le
    // premier play (le direct TS n'a pas d'équivalent FRAG_BUFFERED pour
    // déclencher la lecture au bon moment).
    let startupPoll: ReturnType<typeof setInterval> | null = null;
    startupAtRef.current = performance.now();
    rebufferCountRef.current = 0;
    stallPauseRef.current = false;
    liveEdgeRef.current = 0;
    sessionStartRef.current = Date.now();
    sessionLogRef.current = [];
    logSession('session-start', urls[urlIndex] ? `source ${urlIndex + 1}/${urls.length}` : 'aucune source');
    setStatus('loading'); setBuffering(false); setLevels([]); setActiveLevel(-1); setAutoplayBlocked(false); setMutedAutoplay(false); setIsPaused(true); setRetrying(false); setLiveProgress(0); setBandwidth(null); setErrorInfo({ type: null, httpCode: null });
    setStats({ startupMs: null, rebufferCount: 0, bufferAhead: 0, bitrate: null, latency: null });
    const clearTimers = (): void => { if (deadlineTimer) clearTimeout(deadlineTimer); if (retryTimer) clearTimeout(retryTimer); if (warmupTimer) clearTimeout(warmupTimer); if (startupPoll) clearInterval(startupPoll); if (fastStartTimerRef.current) clearTimeout(fastStartTimerRef.current); deadlineTimer = retryTimer = warmupTimer = null; startupPoll = null; fastStartTimerRef.current = null; };
    const destroy = (): void => {
      const hls = hlsRef.current;
      if (hls) {
        // Chaque étape est isolée : une exception dans hls.js ne doit jamais
        // empêcher le nettoyage du <video> (sinon l'ancien flux continue de
        // jouer en arrière-plan après un changement de chaîne).
        try { hls.stopLoad(); } catch { /* ignore */ }
        try { hls.detachMedia(); } catch { /* ignore */ }
        try { hls.destroy(); } catch { /* ignore */ }
      }
      hlsRef.current = null;
      const mplayer = mpegtsRef.current;
      if (mplayer) {
        try { mplayer.pause(); } catch { /* ignore */ }
        try { mplayer.unload(); } catch { /* ignore */ }
        try { mplayer.detachMediaElement(); } catch { /* ignore */ }
        try { mplayer.destroy(); } catch { /* ignore */ }
      }
      mpegtsRef.current = null;
      try { el.pause(); } catch { /* ignore */ }
      try { el.removeAttribute('src'); el.load(); } catch { /* ignore */ }
    };
    const bufferAhead = (): number => el.buffered.length === 0 ? 0 : Math.max(0, el.buffered.end(el.buffered.length - 1) - el.currentTime);
    const updateStats = (latency: number | null = null): void => setStats((c) => ({ ...c, bufferAhead: bufferAhead(), latency }));
    const markReady = (): void => { if (cancelled) return; started = true; retries = 0; networkRetries = 0; levelRetries = 0; setStatus('ready'); setBuffering(false); setRetrying(false); setStats((c) => ({ ...c, startupMs: c.startupMs ?? performance.now() - startupAtRef.current, rebufferCount: rebufferCountRef.current, bufferAhead: bufferAhead() })); if (deadlineTimer) clearTimeout(deadlineTimer); scheduleFastStartRelease(); };
    // Fast-start : une fois la lecture lancée, on laisse FAST_START_STABLE_MS
    // de lecture SANS rebuffer avant de rendre la main à l'ABR (currentLevel
    // = -1). Un rebuffer pendant la fenêtre (fastStartRebuffered, posé dans
    // onWaiting) relance la fenêtre au lieu de libérer — l'ABR ne reprend que
    // sur une lecture réellement stable. Les fragments basse qualité
    // téléchargés pendant la fenêtre alimentent l'EWMA : à la libération,
    // l'ABR monte en qualité selon la bande passante réellement mesurée (le
    // warmup cap anti-overshoot, inchangé, borne ses premières montées).
    const scheduleFastStartRelease = (): void => {
      if (cancelled || !fastStartActiveRef.current) return;
      if (fastStartTimerRef.current) clearTimeout(fastStartTimerRef.current);
      fastStartTimerRef.current = setTimeout(() => {
        fastStartTimerRef.current = null;
        if (cancelled || !fastStartActiveRef.current) return;
        if (fastStartRebuffered) {
          fastStartRebuffered = false;
          logSession('fast-start', 'rebuffer pendant la fenêtre — relance de la stabilité');
          scheduleFastStartRelease();
          return;
        }
        const hls = hlsRef.current;
        if (!hls) return;
        fastStartActiveRef.current = false;
        hls.currentLevel = -1;
        logSession('fast-start', `ABR libéré après ${FAST_START_STABLE_MS / 1000} s de lecture stable`);
      }, FAST_START_STABLE_MS);
    };
    // Épuisement des retries et des URL : on demande une URL fraîche à la page
    // (le jeton fournisseur a pu expirer) avant d'abandonner sur l'erreur.
    const exhausted = (): void => {
      if (cancelled) return;
      if (!refreshUsed && onRefreshSource) {
        refreshUsed = true;
        setRetrying(true);
        void Promise.resolve(onRefreshSource()).then((refreshed) => {
          if (cancelled) return;
          if (refreshed) { urlIndex = 0; retries = 0; networkRetries = 0; levelRetries = 0; loadCurrent(); return; }
          setStatus('error'); setRetrying(false);
        });
        return;
      }
      setStatus('error'); setRetrying(false);
    };
    const advance = (): void => { if (cancelled) return; retries += 1; logSession('advance', `tentative locale ${retries}/${MAX_RETRIES + 1}`); setRetrying(true); if (retries <= MAX_RETRIES) { retryTimer = setTimeout(loadCurrent, exponentialDelay(retries)); return; } if (urlIndex + 1 < urls.length) { urlIndex += 1; retries = 0; networkRetries = 0; levelRetries = 0; logSession('advance', `source suivante ${urlIndex + 1}/${urls.length}`); loadCurrent(); return; } logSession('exhausted', 'retries épuisés, refresh source demandé'); exhausted(); };
    function loadCurrent(): void {
      if (cancelled) return;
      clearTimers(); destroy(); setStatus('loading'); setRetrying(false); setLevels([]); setActiveLevel(-1); startupAtRef.current = performance.now();
      fragDurationRef.current = 0;
      // Fast-start repart de zéro à chaque chargement (source suivante, retry…).
      fastStartActiveRef.current = false;
      fastStartRebuffered = false;
      // Si le navigateur refuse la lecture audible (politique autoplay), on
      // retente en muet pour ne jamais rester bloqué sur le spinner ; l'UI
      // propose ensuite de réactiver le son.
      const attemptPlayback = (): void => {
        if (playbackInitiated || cancelled || !el.isConnected) return;
        playbackInitiated = true;
        // Lecture automatique désactivée dans les préférences : le buffer se
        // remplit, l'invite « Lancer la lecture » prend le relais.
        if (!autoPlay) { setAutoplayBlocked(true); return; }
        void el.play().catch(() => {
          if (cancelled) return;
          el.muted = true;
          setMuted(true);
          setMutedAutoplay(true);
          void el.play().catch(() => setAutoplayBlocked(true));
        });
      };
      const url = urls[urlIndex];
      const isHlsStream = /m3u8/i.test(url);
      // Seuil de démarrage : au moins le plancher du profil, sinon 1,5× la
      // durée d'un segment (bornée) dès que la playlist la révèle.
      // Fast-start : un SEUL segment téléchargé suffit — la cible devient la
      // durée d'un segment (borne à 4 s), sans le plancher de 5-6 s du profil.
      // Distinct du buffer cible de lecture (maxBufferLength 40-60 s) qui ne
      // s'applique qu'une fois la lecture lancée.
      const startupBufferTarget = (): number => {
        if (fastStartActiveRef.current) {
          const seg = fragDurationRef.current;
          return Math.max(1, Math.min(seg || 2, FAST_START_MAX_BUFFER_SECONDS));
        }
        if (!fragDurationRef.current) return startBufferRef.current;
        return clamp(fragDurationRef.current * 1.5, startBufferRef.current, START_BUFFER_MAX_SECONDS);
      };
      // Flux MPEG-TS brut (portails Stalker MAC) : mpegts.js via MSE —
      // hls.js exigerait un manifest .m3u8 et n'en sortirait jamais.
      if (!isHlsStream) {
        started = false;
        playbackInitiated = false;
        mediaRecoveries = 0;
        const profile = networkProfile();
        startBufferRef.current = profile.startBuffer;
        // Profil adaptatif TS : connexion faible = matelas de démarrage plus
        // épais (le débit amont est la ressource rare, pas la latence) ;
        // chasing plus tolérant pour éviter de rattraper le live trop
        // souvent (chaque rattrapage = pic de débit = stall en cascade).
        const weak = profile.capHeight === 360 || profile.estimate <= 750_000;
        deadlineTimer = setTimeout(() => { if (!cancelled && !started) advance(); }, STARTUP_DEADLINE_MS);
        void loadMpegts().then((mpegts) => {
          if (cancelled) return;
          if (!mpegts) { console.warn('[player] mpegts.js introuvable'); advance(); return; }
          if (mpegtsRef.current || hlsRef.current) return;
          if (!mpegts.getFeatureList().mseLivePlayback) { console.warn('[player] MSE TS indisponible'); advance(); return; }
          try {
            // Connexion faible : matelas de démarrage et de reprise plus épais
            // (le débit amont est la ressource rare — on sacrifie la latence).
            const mplayer = mpegts.createPlayer(
              { type: 'mpegts', isLive: true, url },
              {
                // Stash actif : lisse les rafales réseau avant l'append MSE
                // (descripteur de saisie = moins de micro-stalls).
                enableStashBuffer: true,
                stashInitialSize: weak ? 1024 * 1024 : 512 * 1024,
                lazyLoad: false,
                // Chasing nécessaire : certains panels émettent des PTS
                // énormes (décalage de plusieurs heures) — sans le
                // positionnement sur le live edge, la vidéo reste à t=0
                // sans rien à lire. Tolérant (25 s) pour éviter les sauts ;
                // marge de reprise étoffée (6/10 s) = moins de rattrapages
                // en cascade sur connexion instable.
                liveBufferLatencyChasing: true,
                liveBufferLatencyMaxLatency: 25,
                liveBufferLatencyMinRemain: weak ? 10 : 6,
                accurateSeek: false,
              },
            );
            mpegtsRef.current = mplayer;
            retryRef.current = loadCurrent;
            mplayer.attachMediaElement(el);
            mplayer.on(mpegts.Events.ERROR, (errorType: string) => {
              if (cancelled || mpegtsRef.current !== mplayer) return;
              setErrorInfo({ type: errorType.toLowerCase(), httpCode: null });
              // Le panel envoie un segment TS fini (pas un flux infini) :
              // une fois consommé, rafraîchir l'URL directement est plus
              // rapide que le cycle retry → exhausted → refresh.
              advance();
            });
            mplayer.load();
            // Sonde de démarrage mpegts : hls.js attend un matelas d'ABR,
            // mais un flux TS live (chasing actif) garde currentTime près du
            // live edge — le buffer « devant » reste petit. Le bon signal est
            // simplement l'arrivée de données (buffered non vide) ; mpegts
            // gère lui-même le remplissage.
            startupPoll = setInterval(() => {
              if (cancelled || started || !el.isConnected) { if (startupPoll) { clearInterval(startupPoll); startupPoll = null; } return; }
              if (el.buffered.length > 0 && bufferAhead() >= 0.5) {
                if (startupPoll) { clearInterval(startupPoll); startupPoll = null; }
                attemptPlayback();
              }
            }, 250);
          } catch {
            advance();
          }
          return;
        });
        return;
      }
      if (!Hls.isSupported()) { el.src = urls[urlIndex]; el.load(); return; }
      started = false;
      playbackInitiated = false;
      mediaRecoveries = 0;
      deadlineTimer = setTimeout(() => { if (!cancelled && !started) { if (bufferAhead() >= MIN_VIABLE_BUFFER_SECONDS) attemptPlayback(); else advance(); } }, STARTUP_DEADLINE_MS);
      const profile = networkProfile();
      startBufferRef.current = profile.startBuffer;
      // startLevel -1 dans la config : le niveau de départ est fixé au
      // MANIFEST_PARSED par le fast-start (niveau le plus bas, voir plus
      // bas) puis l'ABR est libéré après une lecture stable — l'estimation
      // réseau (abrEwmaDefaultEstimate) ne sert plus qu'au warm-up cap.
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false, startFragPrefetch: true, backBufferLength: 6, maxBufferLength: profile.buffer, maxMaxBufferLength: 90, maxBufferSize: 60 * 1000 * 1000, maxBufferHole: 0.5, liveSyncDuration: profile.liveSyncSeconds, liveMaxLatencyDuration: profile.liveMaxLatencySeconds, startLevel: -1, abrEwmaDefaultEstimate: profile.estimate, abrEwmaFastVoD: 2, abrEwmaSlowVoD: 5, abrBandWidthFactor: 0.7, abrBandWidthUpFactor: 0.5, abrMaxWithRealBitrate: true, capLevelToPlayerSize: true, maxLoadingDelay: 2, maxFragLookUpTolerance: 0.3, manifestLoadingTimeOut: 15_000, manifestLoadingMaxRetry: 3, levelLoadingTimeOut: 15_000, levelLoadingMaxRetry: 3, fragLoadingTimeOut: 20_000, fragLoadingMaxRetry: 4, maxStarvationDelay: 8 });
      hlsRef.current = hls; retryRef.current = loadCurrent; hls.loadSource(urls[urlIndex]); hls.attachMedia(el);
      hls.on(Hls.Events.ERROR, (_event, data: ErrorData) => {
        if (cancelled || !data.fatal) return;
        logSession('hls-error', `${data.type}/${data.details}${data.response ? ` http ${data.response.code}` : ''}${data.fatal ? ' [fatal]' : ''}`);
        if (data.type === ErrorTypes.MEDIA_ERROR) { mediaRecoveries += 1; if (mediaRecoveries > 3) { advance(); return; } if (el.buffered.length > 0 && el.currentTime + 0.5 < el.buffered.end(el.buffered.length - 1)) el.currentTime += 0.5; try { hls.recoverMediaError(); } catch { advance(); } return; }
        if (data.type === ErrorTypes.NETWORK_ERROR) {
          const code = data.response?.code ?? null;
          // 401/403 = jeton expiré, 404 = flux retiré : inutile d'insister sur
          // la même URL (le proxy a déjà retenté sa chaîne en amont).
          if (code === 401 || code === 403 || code === 404) { setErrorInfo({ type: 'networkError', httpCode: code }); if (urlIndex + 1 < urls.length) { urlIndex += 1; retries = 0; networkRetries = 0; levelRetries = 0; loadCurrent(); } else exhausted(); return; }
          // Erreurs fatales manifest/level : retry LÉGER (startLoad ne détruit
          // pas le player, reprend au live edge) avec backoff 500 ms → 1 s →
          // 2 s avant le reload destructeur de advance().
          if ([Hls.ErrorDetails.MANIFEST_LOAD_ERROR, Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT, Hls.ErrorDetails.LEVEL_LOAD_ERROR, Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT].includes(data.details)) {
            levelRetries += 1;
            if (levelRetries <= MAX_LEVEL_RETRIES) {
              logSession('level-retry', `${data.details} tentative ${levelRetries}/${MAX_LEVEL_RETRIES}`);
              setRetrying(true);
              retryTimer = setTimeout(() => { if (!cancelled && hlsRef.current === hls) { setRetrying(false); hls.startLoad(-1); } }, levelRetryDelay(levelRetries));
              return;
            }
            setErrorInfo({ type: 'networkError', httpCode: code });
            advance();
            return;
          }
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
        const baseCap = initialDataSaver ? Math.min(networkCapRef.current < 0 ? dataCap : networkCapRef.current, dataCap) : networkCapRef.current;
        // Warm-up anti-overshoot (voir START_WARMUP_MS) : on plafonne au
        // niveau le plus haut dont le bitrate tient dans l'estimation
        // conservative du profil ; un seul niveau bas suffit à en profiter.
        const safeLevels = discovered.filter((l) => (l.bitrate ? l.bitrate <= profile.estimate : l.height <= 720));
        const warmCap = safeLevels.length > 0 ? Math.max(0, ...safeLevels.map((l) => l.index)) : -1;
        const combine = (a: number, b: number): number => (a < 0 ? b : b < 0 ? a : Math.min(a, b));
        if (warmCap >= 0 && warmCap !== baseCap) {
          hls.autoLevelCapping = combine(baseCap, warmCap);
          warmupTimer = setTimeout(() => { if (!cancelled && hlsRef.current === hls) hls.autoLevelCapping = baseCap; }, START_WARMUP_MS);
        } else {
          hls.autoLevelCapping = baseCap;
        }
        // Fast-start (mode Auto uniquement — un choix manuel de l'utilisateur
        // est respecté tel quel) : on fixe currentLevel au niveau le PLUS BAS
        // disponible plutôt que de laisser l'ABR choisir dès le premier
        // segment ; markReady programmera la libération ABR après une lecture
        // stable (voir markReady / FAST_START_STABLE_MS). Mono-variante :
        // rien de plus bas où démarrer (voir la note FAST START en tête de
        // fichier) — seul le buffer de démarrage réduit s'applique.
        if (preferredHeight === -1 && discovered.length > 0) {
          fastStartActiveRef.current = true;
          fastStartRebuffered = false;
          hls.currentLevel = discovered.reduce((lowest, l) => (l.height < lowest.height ? l : lowest), discovered[0]).index;
        } else {
          hls.currentLevel = resolveHeightIndex(discovered, preferredHeight);
        }
        if (bufferAhead() >= startupBufferTarget()) attemptPlayback();
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => { if (!cancelled) { setActiveLevel(data.level); setStats((c) => ({ ...c, bitrate: hls.levels[data.level]?.bitrate ?? null })); } });
      hls.on(Hls.Events.LEVEL_UPDATED, (_event, data) => { fragDurationRef.current = targetDurationOf(data.details) || fragDurationRef.current; const edge = data.details.live ? data.details.edge : null; updateStats(edge === null ? null : Math.max(0, edge - el.currentTime)); });
      hls.on(Hls.Events.FRAG_BUFFERED, () => { networkRetries = 0; setBandwidth(hls.bandwidthEstimate); updateStats(); if (!playbackInitiated && bufferAhead() >= startupBufferTarget()) attemptPlayback(); else resumeIfBuffered(); });
    }
    const onPlaying = (): void => {
      // Garde-fou déterministe : un <video> détaché du DOM (ancien lecteur
      // après un changement de chaîne) ne doit JAMAIS jouer — c'est lui qui
      // volait la lecture en arrière-plan et mettait en pause la chaîne
      // courante (focus audio du WebView).
      if (!el.isConnected) {
        try { el.pause(); } catch { /* ignore */ }
        return;
      }
      markReady();
    };
    const onCanPlay = (): void => { if (!Hls.isSupported()) markReady(); };
    const onWaiting = (): void => {
      if (!started) return;
      rebufferCountRef.current += 1;
      logSession('rebuffer', `#${rebufferCountRef.current} buffer ${bufferAhead().toFixed(1)} s`);
      // Rebuffer pendant la fenêtre fast-start : la libération ABR est
      // annulée — elle ne repartra qu'après une nouvelle période de stabilité
      // (le prochain 'playing' reprogramme la fenêtre via markReady).
      if (fastStartActiveRef.current) {
        fastStartRebuffered = true;
        if (fastStartTimerRef.current) { clearTimeout(fastStartTimerRef.current); fastStartTimerRef.current = null; }
      }
      setStats((c) => ({ ...c, rebufferCount: rebufferCountRef.current }));
      // Flux TS continu (mpegts) : on NE met pas la vidéo en pause — mpegts
      // continue d'append au buffer et le <video> reprend tout seul dès que
      // les données arrivent (comportement natif, sans le gel d'un cycle
      // pause/reprise manuel conçu pour la gestion de live edge de hls.js).
      if (!mpegtsRef.current) {
        const ahead = bufferAhead();
        if (ahead <= STALL_PAUSE_THRESHOLD_SECONDS && !el.paused) { el.pause(); stallPauseRef.current = true; }
      }
      setBuffering(true);
    };
    // Reprise après stall partagée HLS/mpegts : FRAG_BUFFERED n'existe que
    // chez hls.js — côté MPEG-TS, « canplay » signale que le décodeur a de
    // nouveau de quoi lire. Sans ce pont, la première saccade laissait la
    // lecture en pause pour toujours (l'utilisateur devait relancer à la main).
    const resumeIfBuffered = (): void => {
      if (cancelled || !started || !stallPauseRef.current) return;
      // TS : buffer plus épais avant reprise pour éviter une nouvelle stall
      // immédiate (le prochain cycle couperait à nouveau l'image).
      const target = mpegtsRef.current ? 6 : RESUME_BUFFER_SECONDS;
      if (bufferAhead() >= target) { stallPauseRef.current = false; setBuffering(false); void el.play().catch(() => undefined); }
    };
    const resumeCheck = (): void => {
      networkRetries = 0;
      updateStats();
      if (!playbackInitiated && bufferAhead() >= MIN_VIABLE_BUFFER_SECONDS) { playbackInitiated = true; void el.play().catch(() => undefined); }
      else resumeIfBuffered();
    };
    // Reprise : les événements média (stalled/canplay/progress) sont levés
    // quel que soit le moteur (hls.js ou mpegts) — contrairement à
    // FRAG_BUFFERED qui est spécifique à hls.js.
    const onStalledOrCanplay = (): void => { resumeCheck(); };
    const onPlayingReset = (): void => { if (started && !stallPauseRef.current) { setBuffering(false); updateStats(); } };
    const onError = (): void => { if (Hls.isSupported()) return; advance(); };
    el.addEventListener('playing', onPlaying); el.addEventListener('canplay', onCanPlay); el.addEventListener('waiting', onWaiting); el.addEventListener('playing', onPlayingReset); el.addEventListener('error', onError);
    el.addEventListener('canplay', onStalledOrCanplay); el.addEventListener('stalled', onStalledOrCanplay); el.addEventListener('progress', onStalledOrCanplay);
    if (Hls.isSupported()) loadCurrent(); else if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = urls[urlIndex]; video.load(); } else setStatus('error');
    return () => { cancelled = true; retryRef.current = null; clearTimers(); destroy(); logSession('session-end', `rebuffers ${rebufferCountRef.current}`); console.info('[player-session]', title, sessionLogRef.current); el.removeEventListener('playing', onPlaying); el.removeEventListener('canplay', onCanPlay); el.removeEventListener('waiting', onWaiting); el.removeEventListener('playing', onPlayingReset); el.removeEventListener('error', onError); el.removeEventListener('canplay', onStalledOrCanplay); el.removeEventListener('stalled', onStalledOrCanplay); el.removeEventListener('progress', onStalledOrCanplay); };
  }, [urlsKey]);

  const activeHeight = levels.find((l) => l.index === activeLevel)?.height;
  const qualityLabel = dataSaver
    ? `Éco${activeHeight ? ` · ${activeHeight}p` : ''}`
    : selectedHeight === -1
      ? `Auto${activeHeight ? ` · ${activeHeight}p` : ''}`
      : `${selectedHeight}p`;
  // « Réessayer » : on rafraîchit d'abord l'URL côté page (jeton possiblement
  // expiré). Reload local UNIQUEMENT si l'URL est identique — sinon l'effet
  // [urlsKey] repart de lui-même et un reload local doublerait le chargement.
  const retry = (): void => {
    const urlBefore = urlsRef.current[0];
    void Promise.resolve(onRefreshSource?.())
      .catch(() => false)
      .then(() => {
        if (urlsRef.current[0] === urlBefore) retryRef.current?.();
      });
  };
  useEffect(() => { const hls = hlsRef.current; if (!hls || levels.length === 0) return; const dataCap = Math.max(0, ...levels.filter((l) => l.height <= DATA_SAVER_MAX_HEIGHT).map((l) => l.index)); hls.autoLevelCapping = dataSaver ? Math.min(networkCapRef.current < 0 ? dataCap : networkCapRef.current, dataCap) : networkCapRef.current; // Un choix manuel explicite prime sur Éco (qui n'est qu'un plafond auto).
    // Choix manuel hors Auto : on annule le fast-start (la libération ABR
    // programmée ne doit jamais écraser la qualité choisie). Auto pendant un
    // fast-start actif : on ne touche PAS à currentLevel — c'est le
    // fast-start qui le pilote (sans ce garde, cet effet, déclenché par le
    // setLevels du MANIFEST_PARSED, remettrait -1 juste après le passage au
    // niveau bas et annulerait le démarrage rapide).
    if (resolvedIndex !== -1) {
      if (fastStartTimerRef.current) { clearTimeout(fastStartTimerRef.current); fastStartTimerRef.current = null; }
      fastStartActiveRef.current = false;
    } else if (fastStartActiveRef.current) return;
    hls.currentLevel = resolvedIndex; }, [dataSaver, resolvedIndex, levels]);
  useEffect(() => { const video = videoRef.current; if (!video || initialVolume === undefined) return; video.volume = initialVolume; setVolume(initialVolume); const onVol = (): void => { setVolume(video.volume); onVolumeChange?.(video.volume); }; video.addEventListener('volumechange', onVol); return () => video.removeEventListener('volumechange', onVol); }, [initialVolume, onVolumeChange]);

  const VolumeIcon = muted || volume === 0 ? Icon.VolumeX : volume < 0.5 ? Icon.Volume1 : Icon.Volume2;
  const errorMsg = status === 'error' ? getErrorMessage(errorInfo.type, errorInfo.httpCode) : '';
  const net = getNetworkInfo();
  const isIos = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);

  return <div ref={containerRef} className={`${styles.player} ${controlsVisible ? styles.controlsVisible : ''} ${isMobile ? styles.mobile : ''} ${isPseudoFullscreen ? styles.pseudoFullscreen : ''}`} data-state={status} onMouseMove={!isMobile ? showControls : undefined} onMouseLeave={() => { if (!isMobile && status === 'ready') setControlsVisible(false); }} onTouchStart={(e) => { showControls(); handleTouchStart(e); }} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
    <video ref={videoRef} className={styles.video} playsInline preload="auto" onClick={handleVideoClick} aria-label={`Lecteur ${title}`} />
    {status !== 'ready' && <div className={styles.overlay} role="status" aria-live="polite"><div className={styles.signal}><span className={styles.signalDot} /><span>{retrying ? 'Reconnexion au flux…' : status === 'error' ? 'Flux indisponible' : 'Connexion au direct'}</span></div>{status === 'loading' && (autoplayBlocked ? <><h2 className={styles.title}>Lecture en attente</h2><button type="button" className={styles.retryButton} onClick={startPlayback}>Lancer la lecture</button></> : <><Spinner />{retrying && <p className={styles.hint}>Nouvelle tentative…</p>}</>)}{status === 'error' && <><h2 className={styles.title}>Lecture interrompue</h2><p className={styles.hint}>{errorMsg}</p><div className={styles.errorMeta}><span className={styles.errorTag}>Réseau : {net.effectiveType}{net.downlink > 0 ? ` · ${net.downlink} Mbps` : ''}</span>{net.saveData && <span className={styles.errorTag}>Mode économie activé</span>}</div><button type="button" className={styles.retryButton} onClick={retry}>Réessayer</button></>}</div>}
    {status === 'ready' && buffering && <div className={styles.bufferingOverlay} role="status" aria-label="Mise en mémoire tampon"><Spinner /><span>{stallPauseRef.current ? `Lissage du flux… reprise à ${RESUME_BUFFER_SECONDS} s de marge` : 'Rattrapage du direct…'}</span></div>}
    {bandwidth !== null && controlsVisible && <div className={styles.bandwidthBadge} role="status" aria-label="Débit réseau en temps réel"><Icon.Activity size={13} aria-hidden /><span>{formatBitrate(bandwidth)}</span></div>}
    {status === 'ready' && (autoplayBlocked || mutedAutoplay) && <button type="button" className={styles.playPrompt} onClick={startPlayback}>{autoplayBlocked ? 'Lancer la lecture' : 'Activer le son'}</button>}
    {gestureOverlay && <div className={styles.gestureOverlay} role="status" aria-live="polite"><span className={styles.gestureIcon}><Icon.Volume2 size={28} /></span><span className={styles.gestureValue}>{gestureOverlay.value}%</span></div>}
    {status === 'ready' && <div className={styles.progressBar} title={stats.latency !== null ? `Latence au direct : ${formatBuffer(stats.latency)}` : undefined}><div className={styles.progressFill} style={{ width: `${liveProgress}%` }} /></div>}
    {status === 'ready' && !isMobile && <div className={styles.controlRail} aria-label="Contrôles du lecteur"><button type="button" className={styles.iconBtn} onClick={togglePlayback} aria-label={isPaused ? 'Lire' : 'Pause'}>{isPaused ? <Icon.Play size={16} /> : <Icon.Pause size={16} />}</button><span className={styles.liveBadge}>DIRECT</span><span className={styles.stat}>Qualité {qualityLabel}</span><span className={styles.statWrap}><span className={styles.statHint}>Buffer {formatBuffer(stats.bufferAhead)}</span><span className={styles.statTooltip}>Secondes de vidéo en mémoire tampon</span></span><span className={styles.statWrap}><span className={styles.statHint}>Démarrage {formatDuration(stats.startupMs)}</span><span className={styles.statTooltip}>Temps de chargement initial</span></span>{stats.rebufferCount > 0 && <span className={styles.statWarning}>Rebuffers {stats.rebufferCount}</span>}<div className={styles.volumeControl}><button type="button" className={styles.iconBtn} onClick={toggleMute} aria-label={muted ? 'Activer le son' : 'Couper le son'}><VolumeIcon size={16} /></button><input type="range" className={styles.volumeSlider} min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={handleVolumeChange} aria-label="Volume" /></div>{levels.length > 1 && <select className={styles.qualitySelect} value={resolvedIndex} aria-label="Qualité vidéo" onChange={(e) => { const idx = Number(e.target.value); const height = idx === -1 ? -1 : (levels.find((l) => l.index === idx)?.height ?? -1); // Un choix manuel hors Auto quitte Éco (sources différentes).
  if (height !== -1 && dataSaver) { setDataSaver(false); onDataSaverChange?.(false); } setSelectedHeight(height); onLevelChange?.(height); }}><option value={-1}>Auto{activeHeight ? ` — ${activeHeight}p` : ''}</option>{levels.map((level) => <option key={level.index} value={level.index}>{level.height}p — {formatBitrate(level.bitrate)}</option>)}</select>}<label className={styles.dataSaverToggle}><input type="checkbox" checked={dataSaver} onChange={(e) => { setDataSaver(e.target.checked); onDataSaverChange?.(e.target.checked); }} />Éco</label>{pipSupported && <button type="button" className={styles.iconBtn} onClick={() => void togglePip()} aria-label={isPip ? 'Quitter le mini-player' : 'Mini-player'}><Icon.Monitor size={16} /></button>}{fsSupported && <button type="button" className={styles.iconBtn} onClick={toggleFullscreen} aria-label={isFullscreen || isPseudoFullscreen ? 'Quitter le plein écran' : 'Plein écran'}>{isFullscreen || isPseudoFullscreen ? <Icon.Minimize size={16} /> : <Icon.Maximize size={16} />}</button>}</div>}
    {status === 'ready' && isMobile && <div className={styles.mobileTopBar}><span className={styles.liveBadge}>DIRECT</span><span className={styles.mobileQualityLabel}>{qualityLabel}</span></div>}
    {status === 'ready' && isMobile && <div className={styles.mobileBottomBar} aria-label="Contrôles du lecteur"><button type="button" className={styles.mobileIconBtn} onClick={togglePlayback} aria-label={isPaused ? 'Lire' : 'Pause'}>{isPaused ? <Icon.Play size={20} /> : <Icon.Pause size={20} />}</button><button type="button" className={styles.mobileIconBtn} onClick={toggleMute} aria-label={muted ? 'Activer le son' : 'Couper le son'}><VolumeIcon size={20} /></button>{levels.length > 1 && <button type="button" className={`${styles.mobileIconBtn} ${activePopup === 'quality' ? styles.mobileIconBtnActive : ''}`} onClick={() => setActivePopup(activePopup === 'quality' ? null : 'quality')} aria-label="Qualité vidéo"><Icon.Settings2 size={20} /></button>}<label className={styles.mobileIconBtn}><input type="checkbox" checked={dataSaver} onChange={(e) => { setDataSaver(e.target.checked); onDataSaverChange?.(e.target.checked); }} className={styles.mobileCheckbox} /><span className={dataSaver ? styles.mobileEcoActive : ''}>Éco</span></label>{pipSupported && <button type="button" className={styles.mobileIconBtn} onClick={() => void togglePip()} aria-label={isPip ? 'Quitter le mini-player' : 'Mini-player'}><Icon.Monitor size={20} /></button>}{fsSupported && <button type="button" className={styles.mobileIconBtn} onClick={toggleFullscreen} aria-label={isFullscreen || isPseudoFullscreen ? 'Quitter le plein écran' : 'Plein écran'}>{isFullscreen || isPseudoFullscreen ? <Icon.Minimize size={20} /> : <Icon.Maximize size={20} />}</button>}</div>}
    {isMobile && activePopup && <div className={styles.popupBackdrop} onClick={closePopup} />}
    {isMobile && activePopup === 'quality' && <div className={styles.mobilePopup} role="dialog" aria-label="Choisir la qualité"><div className={styles.popupHeader}><span className={styles.popupTitle}>Qualité vidéo</span><button type="button" className={styles.popupClose} onClick={closePopup} aria-label="Fermer"><Icon.X size={18} /></button></div><div className={styles.popupOptions}><button type="button" className={`${styles.popupOption} ${selectedHeight === -1 ? styles.popupOptionActive : ''}`} onClick={() => { setSelectedHeight(-1); onLevelChange?.(-1); closePopup(); }}><span>Auto{activeHeight ? ` — ${activeHeight}p` : ''}</span>{selectedHeight === -1 && <Icon.Check size={16} />}</button>{levels.map((level) => <button key={level.index} type="button" className={`${styles.popupOption} ${resolvedIndex === level.index ? styles.popupOptionActive : ''}`} onClick={() => { if (dataSaver) { setDataSaver(false); onDataSaverChange?.(false); } setSelectedHeight(level.height); onLevelChange?.(level.height); closePopup(); }}><span className={styles.popupOptionLeft}><span>{level.height}p</span>{level.bitrate && <span className={styles.bitrateBadge}>{formatBitrate(level.bitrate)}</span>}</span>{resolvedIndex === level.index && <Icon.Check size={16} />}</button>)}</div></div>}
    {isMobile && activePopup === 'volume' && <div className={styles.mobilePopup} role="dialog" aria-label="Volume"><div className={styles.popupHeader}><span className={styles.popupTitle}>Volume</span><button type="button" className={styles.popupClose} onClick={closePopup} aria-label="Fermer"><Icon.X size={18} /></button></div><div className={styles.popupVolumeContent}>{isIos ? <p className={styles.popupVolumeHint}>Sur iOS, le volume se contrôle via les boutons physiques de l'appareil.</p> : <div className={styles.popupVolumeSlider}><button type="button" className={styles.iconBtn} onClick={toggleMute} aria-label={muted ? 'Activer le son' : 'Couper le son'}><VolumeIcon size={20} /></button><input type="range" className={styles.volumeSliderLarge} min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={handleVolumeChange} aria-label="Volume" /><span className={styles.volumePercent}>{muted ? 0 : Math.round(volume * 100)}%</span></div>}</div></div>}
  </div>;
}
