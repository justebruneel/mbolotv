// MediaSession API — contrôles système (écran verrouillé, Bluetooth, OS).
// Progressif et compatible : absent/silencieux là où l'API n'existe pas, et
// JAMAIS obligatoire pour lire (que des métadonnées + handlers play/pause).
// Pas de précédent/suivant : ni le live (pas de piste précédente) ni le
// catalogue (navigation par pages, pas par file) n'ont de sémantique sûre.

export interface MediaSessionInput {
  title: string;
  /** Chaîne (live) ou "Mbolo" (VOD). */
  artist: string;
  album: string;
  artworkUrl?: string | null;
}

export interface BuiltMediaMetadata {
  title: string;
  artist: string;
  album: string;
  artwork: Array<{ src: string; sizes: string; type: string }>;
}

/** Construction pure des métadonnées (testable sans navigateur). Artwork
 *  ignoré si absent/invalide — jamais d'URL inventée. */
export function buildMediaMetadata(input: MediaSessionInput): BuiltMediaMetadata {
  const title = String(input?.title ?? '').slice(0, 200) || 'Mbolo TV';
  const artist = String(input?.artist ?? '').slice(0, 200) || 'Mbolo';
  const album = String(input?.album ?? '').slice(0, 200) || 'Mbolo';
  const art = typeof input?.artworkUrl === 'string' && /^https?:\/\//.test(input.artworkUrl)
    ? [{ src: input.artworkUrl.slice(0, 500), sizes: '512x512', type: 'image/png' }]
    : [];
  return { title, artist, album, artwork: art };
}

export interface MediaSessionHandlers {
  onPlay?: () => void;
  onPause?: () => void;
}

/** Pose métadonnées + état + handlers. Retourne false si indisponible ou en
 *  échec (appelant : ignorer). Ne throw jamais. N'écrase jamais les handlers
 *  par défaut du navigateur quand aucun callback n'est fourni. */
export function updateMediaSession(
  input: MediaSessionInput,
  playbackState: 'playing' | 'paused' | 'none',
  handlers: MediaSessionHandlers = {},
): boolean {
  try {
    if (typeof navigator === 'undefined') return false;
    const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession;
    if (!ms) return false;
    const meta = buildMediaMetadata(input);
    try {
      ms.metadata = new MediaMetadata({
        title: meta.title, artist: meta.artist, album: meta.album,
        artwork: meta.artwork.length ? meta.artwork : undefined,
      });
    } catch { /* MediaMetadata indisponible : on continue sans */ }
    try {
      ms.playbackState = playbackState;
    } catch { /* ignore */ }
    if (handlers.onPlay) {
      try { ms.setActionHandler('play', () => { try { handlers.onPlay?.(); } catch { /* ignore */ } }); } catch { /* ignore */ }
    }
    if (handlers.onPause) {
      try { ms.setActionHandler('pause', () => { try { handlers.onPause?.(); } catch { /* ignore */ } }); } catch { /* ignore */ }
    }
    return true;
  } catch {
    return false;
  }
}

/** Nettoyage : état neutre (montage suivant / destroy). No-throw. */
export function clearMediaSession(): void {
  try {
    const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession;
    if (!ms) return;
    try { ms.playbackState = 'none'; } catch { /* ignore */ }
    try { ms.metadata = null; } catch { /* ignore */ }
  } catch { /* ignore */ }
}
