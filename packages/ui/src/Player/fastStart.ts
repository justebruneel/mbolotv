// Transition fast-start (phase 3) — logique PURE, testée, sans effet de bord.
//
// Rappel baseline (inchangée par défaut) : le Player démarre au niveau le
// PLUS BAS pendant ~6 s de lecture stable, puis rend la main à l'ABR
// (currentLevel = -1). Le passage direct bas → Auto peut faire sauter
// l'ABR vers un niveau insoutenable (EWMA gonflée par le warm) → rebuffer.
//
// Ce module ne décide que TROIS choses, à partir des niveaux RÉELLEMENT
// disponibles (jamais de 360p/480p/720p supposés) :
//   1. lowestLevelIndex : niveau de démarrage (le plus bas) ;
//   2. midLevelIndex : palier intermédiaire éventuel entre le plus bas et le
//      plafond effectif (cap) — null s'il n'existe pas (mono-variante, cap
//      contraint au plus bas) ;
//   3. shouldReleaseFastStart : à l'échéance de la fenêtre, libérer (true) ou
//      prolonger (false : rebuffer en fenêtre, ou buffer non confortable).
// Repli baseline automatique : aucun palier → libération directe (-1),
// mesure absente → libération (on ne colle jamais au niveau bas par défaut).

export interface FastStartLevel { index: number; height: number }

/** Niveau de démarrage : le plus bas (par hauteur). -1 si aucun niveau. */
export function lowestLevelIndex(levels: FastStartLevel[]): number {
  try {
    if (!Array.isArray(levels) || levels.length === 0) return -1;
    return levels.reduce((lowest, l) => (l.height < lowest.height ? l : lowest), levels[0]).index;
  } catch {
    return -1;
  }
}

/** Palier intermédiaire : médian (par hauteur) de [lowest..top], top =
 *  hauteur du niveau plafonné (cap < 0 ou introuvable = tous les niveaux).
 *  null si le médian == lowest (aucun palier utile : mono-variante ou
 *  plafond contraint au plus bas). Les index ne sont jamais supposés triés. */
export function midLevelIndex(levels: FastStartLevel[], lowestIndex: number, capIndex: number): number | null {
  try {
    if (!Array.isArray(levels) || levels.length === 0 || lowestIndex < 0) return null;
    const lowest = levels.find((l) => l.index === lowestIndex);
    if (!lowest) return null;
    const capHeight = capIndex < 0 ? Infinity : (levels.find((l) => l.index === capIndex)?.height ?? Infinity);
    const pool = levels
      .filter((l) => l.height >= lowest.height && l.height <= capHeight)
      .sort((a, b) => a.height - b.height || a.index - b.index);
    if (pool.length < 3) return null; // besoin d'un vrai milieu : bas/milieu/haut
    // Borne BASSE du milieu (montée douce : on préfère sous-estimer le palier
    // plutôt que de sauter trop haut — l'ABR montera ensuite si le débit suit).
    const mid = pool[Math.ceil(pool.length / 2) - 1];
    return mid.index === lowestIndex ? null : mid.index;
  } catch {
    return null;
  }
}

export interface ReleaseInput {
  /** Rebuffer observé pendant la fenêtre : on ne libère jamais dessus. */
  rebuffered: boolean;
  /** Buffer devant la position (s), NaN/inconnu = mesure absente. */
  bufferAheadSec: number;
  /** Seuil de démarrage du flux (startupBufferTarget), > 0 si connu. */
  startupTargetSec: number;
}

export interface ReleaseDecision {
  release: boolean;
  reason: 'stable' | 'rebuffer' | 'buffer' | 'no-measure';
}

/** À l'échéance d'une fenêtre de stabilité : libérer l'ABR ou prolonger ?
 *  - rebuffer → prolonger (rebuffer) ;
 *  - mesure absente → libérer (no-measure : on ne colle jamais au niveau
 *    bas par défaut de mesure) ;
 *  - buffer non CONFORTABLE (bufferLevel, seuils existants) → prolonger ;
 *  - sinon → libérer (stable). */
export function shouldReleaseFastStart(input: ReleaseInput): ReleaseDecision {
  try {
    if (input.rebuffered) return { release: false, reason: 'rebuffer' };
    const buf = input.bufferAheadSec;
    const target = input.startupTargetSec;
    if (!Number.isFinite(buf) || buf < 0 || !(target > 0)) return { release: true, reason: 'no-measure' };
    // Seuil confortable = 2× la cible de démarrage (même convention que le
    // prefetch : bufferLevel(len, target) === 'COMFORTABLE' ⟺ len ≥ 2×target).
    if (buf < target * 2) return { release: false, reason: 'buffer' };
    return { release: true, reason: 'stable' };
  } catch {
    return { release: true, reason: 'no-measure' };
  }
}

/** Action réseau au retour online — table de décision pure (le composant ne
 *  fait qu'exécuter) : erreur affichée → 'retry' (refresh URL existant) ;
 *  pause douce posée → 'startLoad' (reprise position/buffer conservés) ;
 *  lecteur sain → 'none' (laisser hls.js tranquille). */
export function resolveOnlineAction(hasError: boolean, wasStopped: boolean): 'retry' | 'startLoad' | 'none' {
  if (hasError) return 'retry';
  if (wasStopped) return 'startLoad';
  return 'none';
}
