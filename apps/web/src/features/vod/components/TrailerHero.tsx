'use client';

// Bande-annonce intégrée au hero, façon Netflix : l'iframe YouTube se lance
// MUETTE (autoplay+mute, politiques navigateur respectées sans geste
// utilisateur) et remplace l'image de fond, boutons de la fiche superposés.
// Le son n'est activé que sur un geste explicite (bouton / clic) : YouTube
// autorise un unmute programmatique via postMessage après interaction.
//
// URL embed : youtube-nocookie (moins de suivi), controls=0 et modeste
// branding (rel=0, iv_load_policy=3, fs=0) pour un rendu « fond de hero ».
// La boucle passe par le paramètre playlist=<id> (seul moyen fiable en
// iframe API-less). repli : si l'iframe échoue, l'image de fond reste.
//
// Transitions : l'iframe reste invisible (opacity 0) tant que la vidéo ne
// joue pas ; l'état `ready` du hook bascule au premier événement « playing »
// remonté par le player (listener window.message ci-dessous). Le parent
// masque ainsi l'image de fond SEULEMENT quand le film est réellement à
// l'écran — aucun écran YouTube (chargement, titre, cadre sombre) ne se voit.
import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

const UNMUTE_MSG = JSON.stringify({ event: 'command', func: 'unMute', args: [] });
const SET_VOLUME_MSG = JSON.stringify({ event: 'command', func: 'setVolume', args: [100] });
const PLAY_MSG = JSON.stringify({ event: 'command', func: 'playVideo', args: [] });
const TRAILER_LISTENING_ID = 'mbolo-trailer';

function embedUrl(videoId: string): string {
  const params = new URLSearchParams({
    autoplay: '1',
    mute: '1',
    loop: '1',
    controls: '0',
    playlist: videoId,
    rel: '0',
    fs: '0',
    iv_load_policy: '3',
    playsinline: '1',
    // Rendu « fond de hero » : le lecteur YouTube ne doit PAS se voir —
    // pas de barre titre (modestbranding), pas de logo, et l'iframe est
    // dézoomée par le parent (échelle 1,25) pour couper le plein écran
    // YouTube et les chips de recommandation visibles en bas de la vidéo.
    modestbranding: '1',
    // SANS enablejsapi, YouTube IGNORE silencieusement les commandes
    // postMessage (unMute/mute) : le bouton son ne fait rien. Obligatoire.
    enablejsapi: '1',
  });
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
}

// Retourne : iframe muette montée, + état sonore pilotable. Le composant
// n'affiche RIEN de son propre chrome : le parent superpose ses boutons.
// `ready` passe à true uniquement quand la vidéo joue RÉELLEMENT (l'événement
// onStateChange de l'iframe API renvoie « playing ») : le parent peut alors
// faire disparaître l'image de fond — jamais d'écran noir YouTube visible.
export function useTrailerEmbed(videoId: string) {
  const [mounted, setMounted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [muted, setMuted] = useState(true);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Différé de montage : évite de charger l'iframe au premier render (page
  // encore visible du haut vers le bas) — l'équivalent du différé mobile
  // Netflix, 2,5 s suffisent pour ne pas payer le poids YouTube au cold-start.
  useEffect(() => {
    if (!videoId) {
      setMounted(false);
      setReady(false);
      return;
    }
    const timer = setTimeout(() => setMounted(true), 2_500);
    return () => clearTimeout(timer);
  }, [videoId]);
  const post = useCallback((message: string): void => {
    frameRef.current?.contentWindow?.postMessage(message, 'https://www.youtube-nocookie.com');
  }, []);
  const unmute = useCallback((): void => {
    // setVolume après unMute : certains embeds restent à volume 0 tant que
    // setVolume n'a pas été appelé explicitement.
    post(UNMUTE_MSG);
    post(SET_VOLUME_MSG);
    post(PLAY_MSG);
    setMuted(false);
  }, [post]);
  const mute = useCallback((): void => {
    post(JSON.stringify({ event: 'command', func: 'mute', args: [] }));
    setMuted(true);
  }, [post]);
  const fail = useCallback((): void => setFailed(true), []);
  // Remontée des événements du player : au premier « playing », `ready`
  // devient true et le parent fond l'image de fond vers l'iframe. Filet de
  // sécurité : certains environnements (bloqueurs, restrictions cross-origin,
  // iOS) n'acheminent pas l'événement — on considère alors le player prêt
  // après un délai raisonnable, sinon l'image de fond resterait affichée
  // pendant toute la lecture de la bande-annonce.
  useEffect(() => {
    if (!mounted) return;
    const fallback = setTimeout(() => setReady(true), 12_000);
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== 'https://www.youtube-nocookie.com') return;
      let data: { event?: string; info?: unknown; id?: string };
      try { data = JSON.parse(typeof event.data === 'string' ? event.data : ''); } catch { return; }
      if (data?.id !== TRAILER_LISTENING_ID) return;
      if (data.event === 'onStateChange' && data.info === 1) { clearTimeout(fallback); setReady(true); }
      if (data.event === 'onError') { clearTimeout(fallback); setFailed(true); }
    };
    window.addEventListener('message', onMessage);
    return () => { clearTimeout(fallback); window.removeEventListener('message', onMessage); };
  }, [mounted]);
  return { mounted, failed, ready, setReady, setFailed: fail, muted, unmute, mute, frameRef, src: videoId ? embedUrl(videoId) : null };
}

/**
 * L'iframe muette en boucle, invisible tant que la vidéo ne joue pas
 * (opacity 0 → l'écran de chargement/lecture YouTube ne se voit JAMAIS).
 * La bascule vers l'opacité 1 est pilotée par le parent via l'état `ready`
 * du hook (événement onStateChange « playing » de l'iframe API).
 */
export function TrailerFrame({ src, onFailed, frameRef, className = '' }: {
  src: string;
  onFailed: () => void;
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  className?: string;
}): React.ReactElement {
  return (
    <iframe
      ref={frameRef}
      src={src}
      title="Bande-annonce"
      className={className}
      allow="autoplay; encrypted-media; picture-in-picture"
      referrerPolicy="strict-origin-when-cross-origin"
      onError={onFailed}
      onLoad={() => {
        // Handshake iframe API : le player n'écoute les commandes ni ne
        // remonte onStateChange avant ce message « listening ».
        frameRef.current?.contentWindow?.postMessage(
          JSON.stringify({ event: 'listening', id: TRAILER_LISTENING_ID, channel: 'widget' }),
          'https://www.youtube-nocookie.com',
        );
      }}
    />
  );
}
