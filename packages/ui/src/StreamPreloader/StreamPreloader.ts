import Hls from 'hls.js';

interface ActiveWarm { hls: Hls; timer: ReturnType<typeof setTimeout> | null }

let active: ActiveWarm | null = null;
let videoEl: HTMLVideoElement | null = null;

function getVideoElement(): HTMLVideoElement {
  if (videoEl) return videoEl;
  const el = document.createElement('video');
  el.muted = true;
  el.playsInline = true;
  el.preload = 'none';
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, {
    position: 'fixed',
    width: '1px',
    height: '1px',
    left: '-9999px',
    top: '0',
    opacity: '0',
    pointerEvents: 'none',
    zIndex: '-1',
  });
  document.body.appendChild(el);
  videoEl = el;
  return el;
}

export function warmStream(url: string): void {
  if (typeof window === 'undefined' || !Hls.isSupported() || !url) return;
  cancelWarm();
  const video = getVideoElement();
  const hls = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    maxBufferLength: 1,
    maxMaxBufferLength: 2,
    startFragPrefetch: false,
    capLevelToPlayerSize: false,
    manifestLoadingTimeOut: 15_000,
    manifestLoadingMaxRetry: 2,
    levelLoadingTimeOut: 15_000,
    levelLoadingMaxRetry: 2,
    fragLoadingTimeOut: 20_000,
    fragLoadingMaxRetry: 2,
  });
  active = { hls, timer: null };
  hls.loadSource(url);
  hls.attachMedia(video);
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    hls.stopLoad();
    if (active?.hls === hls) {
      active.timer = setTimeout(() => cancelWarm(), 300);
    }
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data.fatal) cancelWarm();
  });
}

export function cancelWarm(): void {
  if (!active) return;
  if (active.timer) clearTimeout(active.timer);
  try {
    active.hls.stopLoad();
    active.hls.detachMedia();
    active.hls.destroy();
  } catch {
    /* noop */
  }
  active = null;
}
