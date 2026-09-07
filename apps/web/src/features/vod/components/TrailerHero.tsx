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
import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

const UNMUTE_MSG = JSON.stringify({ event: 'command', func: 'unMute', args: [] });
const PLAY_MSG = JSON.stringify({ event: 'command', func: 'playVideo', args: [] });

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
    // dézoomée par le parent (échelle 1,33) pour couper le plein écran
    // YouTube et les chips de recommandation visibles en bas de la vidéo.
    modestbranding: '1',
  });
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
}

// Retourne : iframe muette montée, + état sonore pilotable. Le composant
// n'affiche RIEN de son propre chrome : le parent superpose ses boutons.
// (L'interface TrailerHeroProps ci-dessus reste documentative : le hook
// renvoie l'état, le parent rend lui-même TrailerFrame dans SON cadre.)

// Retourne : iframe muette montée, + état sonore pilotable. Le composant
// n'affiche RIEN de son propre chrome : le parent superpose ses boutons.
export function useTrailerEmbed(videoId: string) {
  const [mounted, setMounted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [muted, setMuted] = useState(true);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Différé de montage : évite de charger l'iframe au premier render (page
  // encore visible du haut vers le bas) — l'équivalent du différé mobile
  // Netflix, 2,5 s suffisent pour ne pas payer le poids YouTube au cold-start.
  useEffect(() => {
    if (!videoId) return;
    const timer = setTimeout(() => setMounted(true), 2_500);
    return () => clearTimeout(timer);
  }, [videoId]);
  const post = useCallback((message: string): void => {
    frameRef.current?.contentWindow?.postMessage(message, 'https://www.youtube-nocookie.com');
  }, []);
  const unmute = useCallback((): void => {
    post(UNMUTE_MSG);
    post(PLAY_MSG);
    setMuted(false);
  }, [post]);
  const mute = useCallback((): void => {
    post(JSON.stringify({ event: 'command', func: 'mute', args: [] }));
    setMuted(true);
  }, [post]);
  const fail = useCallback((): void => setFailed(true), []);
  return { mounted, failed, setFailed: fail, muted, unmute, mute, frameRef, src: videoId ? embedUrl(videoId) : null };
}

/** L'iframe seule (muette, en boucle). À monter derrière le contenu du hero. */
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
    />
  );
}
