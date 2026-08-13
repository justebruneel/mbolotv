'use client';

import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Spinner } from '../Spinner/Spinner';
import styles from './Player.module.css';

export interface PlayerProps {
  src: string;
  title: string;
}

export function Player({ src, title }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setStatus('loading');

    let hls: Hls | null = null;
    const onError = (): void => setStatus('error');

    if (Hls.isSupported()) {
      hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) onError();
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => setStatus('ready'));
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.addEventListener('loadedmetadata', () => setStatus('ready'));
      video.addEventListener('error', onError);
    } else {
      onError();
    }

    return () => {
      hls?.destroy();
      video.removeEventListener('loadedmetadata', () => setStatus('ready'));
      video.removeEventListener('error', onError);
    };
  }, [src]);

  return (
    <div className={styles.player}>
      <video ref={videoRef} className={styles.video} controls playsInline />
      {status !== 'ready' && (
        <div className={styles.overlay}>
          {status === 'loading' ? (
            <>
              <Spinner />
              <p className={styles.hint}>Connexion au flux…</p>
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
    </div>
  );
}
