// Contrôleur de préchargement adaptatif LIVE (phase 4) — module PUR.
//
// Rôle unique : décider QUELLE réserve (en secondes) hls.js peut construire,
// en écrivant `hls.config.maxBufferLength` (relu dynamiquement par hls.js à
// chaque décision — aucun recreate, aucun 2e loader, aucun fetch manuel).
// hls.js charge ensuite séquentiellement, via l'unique MeshLoader, jusqu'à la
// cible. Ce module ne connaît ni React, ni hls.js, ni MeshStream : données
// en entrée, décision en sortie. Déterministe et testé.
//
// Profils : NORMAL (baseline profil, comportement actuel) → PROTECT
// (baseline+15, signes de fragilité) → AGGRESSIVE (baseline+30, besoin
// démontré), plafond absolu 90 (maxMaxBufferLength existant, jamais modifié).
// Hystérésis : montée par paliers (jamais NORMAL→AGGRESSIVE direct),
// descente AGGRESSIVE→PROTECT→NORMAL uniquement quand le buffer a
// effectivement atteint la cible (stabilité démontrée, pas temporelle).
// Descente IMMÉDIATE vers baseline (sécurité) si : saveData, page invisible,
// offline, fast-start actif, ou contenu non-live.

export type PreloadProfile = 'NORMAL' | 'PROTECT' | 'AGGRESSIVE';

export interface PreloadInput {
  /** Cible baseline du profil réseau courant (40/50/60). */
  baselineSec: number;
  /** Profil actuellement appliqué (pour l'hystérésis). */
  currentProfile: PreloadProfile;
  /** Cible actuellement appliquée (pour éviter les écritures inutiles). */
  currentTargetSec: number;
  /** Buffer devant la position (s). */
  bufferAheadSec: number;
  /** Débit EWMA lecteur (Mbps), null si aucune mesure. */
  throughputMbps: number | null;
  /** Bitrate du niveau courant (Mbps), null si inconnu. */
  currentBitrateMbps: number | null;
  /** Rebuffers depuis la dernière transition de profil (fenêtre récente). */
  recentRebufferCount: number;
  /** effectiveType navigator.connection (wifi/4g/3g/…), null si absent. */
  networkType?: string | null;
  /** navigator.deviceMemory (Go), null si absent — jamais décisif seul. */
  deviceMemoryGB?: number | null;
  /** navigator.hardwareConcurrency, null si absent — jamais décisif seul. */
  hardwareConcurrency?: number | null;
  /** Économie de données (navigateur ou réglage) : baseline immédiate. */
  saveData: boolean;
  /** Page visible : sinon baseline immédiate. */
  visible: boolean;
  /** Réseau présent : sinon baseline immédiate (pas de montée aveugle). */
  online: boolean;
  /** Fast-start actif : baseline (le démarrage reste prioritaire). */
  fastStart: boolean;
  /** Contenu live : false (VOD/TS/natif) = baseline, jamais d'adaptatif. */
  live: boolean;
}

export interface PreloadDecision {
  profile: PreloadProfile;
  /** Toujours : baseline ≤ target ≤ 90. */
  targetBufferSec: number;
  reason: string;
  /** Faux si profil ET cible identiques à l'entrée (pas d'écriture). */
  changed: boolean;
}

/** Plafond absolu = maxMaxBufferLength existant (jamais modifié). */
export const PRELOAD_HARD_MAX_SEC = 90;
/** Marches au-dessus de la baseline (documentées, testées). */
export const PRELOAD_PROTECT_STEP_SEC = 15;
export const PRELOAD_AGGRESSIVE_STEP_SEC = 30;
/** Marge ABR : l'ABR hls vise bitrate ≤ 0.7×bande → ratio < ~1.43 signifie
 *  que l'ABR devrait déjà descendre ; seuil 1.5 documenté (conservateur). */
export const PRELOAD_TIGHT_RATIO = 1.5;
/** Appareil faible : deviceMemory ≤ 2 Go ou ≤ 4 cœurs — signal parmi
 *  d'autres, jamais décisif seul, jamais déduit de leur absence. */
export const PRELOAD_WEAK_MEMORY_GB = 2;
export const PRELOAD_WEAK_CORES = 4;

type Need = 'NONE' | 'SOFT' | 'HARD';

function clampTarget(baseline: number, wanted: number): number {
  const base = Number.isFinite(baseline) && baseline > 0 ? baseline : 0;
  const t = Number.isFinite(wanted) ? wanted : base;
  return Math.min(PRELOAD_HARD_MAX_SEC, Math.max(base, t));
}

function isSlowNet(networkType: string | null | undefined): boolean {
  const t = String(networkType ?? '').toLowerCase();
  return t === 'slow-2g' || t === '2g' || t === '3g';
}

function isWeakDevice(input: PreloadInput): boolean {
  const mem = input.deviceMemoryGB;
  const cores = input.hardwareConcurrency;
  return (typeof mem === 'number' && Number.isFinite(mem) && mem <= PRELOAD_WEAK_MEMORY_GB)
    || (typeof cores === 'number' && Number.isFinite(cores) && cores <= PRELOAD_WEAK_CORES);
}

/** Besoin brut (sans état, sans guards) à partir des signaux mesurés. */
function rawNeed(input: PreloadInput): Need {
  const tp = typeof input.throughputMbps === 'number' && Number.isFinite(input.throughputMbps) && input.throughputMbps > 0
    ? input.throughputMbps : null;
  const br = typeof input.currentBitrateMbps === 'number' && Number.isFinite(input.currentBitrateMbps) && input.currentBitrateMbps > 0
    ? input.currentBitrateMbps : null;
  const ratio = tp != null && br != null ? tp / br : null;
  const buf = typeof input.bufferAheadSec === 'number' && Number.isFinite(input.bufferAheadSec)
    ? Math.max(0, input.bufferAheadSec) : 0;
  const recent = Number.isFinite(input.recentRebufferCount) && input.recentRebufferCount > 0
    ? Math.floor(input.recentRebufferCount) : 0;
  const slowNet = isSlowNet(input.networkType);
  const weakDev = isWeakDevice(input);
  const tight = ratio != null && ratio < PRELOAD_TIGHT_RATIO;
  const danger = ratio != null && ratio < 1;

  // HARD : besoin démontré — rebuffers répétés, ou débit < bitrate avec
  // buffer faible/rebuffer, ou tension (proche) + petit buffer + fragilité.
  if (recent >= 2) return 'HARD';
  if (danger && (buf < 10 || recent >= 1)) return 'HARD';
  if (tight && buf < 5 && (weakDev || slowNet)) return 'HARD';
  // SOFT : fragilité — tension débit/bitrate, rebuffer isolé, réseau lent,
  // ou appareil faible combiné à un signal réseau/buffer.
  if (tight) return 'SOFT';
  if (recent >= 1) return 'SOFT';
  if (slowNet) return 'SOFT';
  if (weakDev && (tight || buf < 12 || slowNet)) return 'SOFT';
  if (weakDev && buf < 12 && ratio == null) return 'SOFT'; // appareil faible + petit buffer, sans mesure débit
  return 'NONE';
}

function targetFor(baseline: number, profile: PreloadProfile): number {
  if (profile === 'AGGRESSIVE') return clampTarget(baseline, baseline + PRELOAD_AGGRESSIVE_STEP_SEC);
  if (profile === 'PROTECT') return clampTarget(baseline, baseline + PRELOAD_PROTECT_STEP_SEC);
  return clampTarget(baseline, baseline);
}

/** Décision complète : guards de sécurité → transitions avec hystérésis. */
export function decidePreloadTarget(input: PreloadInput): PreloadDecision {
  try {
    const baseline = Number.isFinite(input.baselineSec) && input.baselineSec > 0 ? input.baselineSec : 0;
    const cur: PreloadProfile = input.currentProfile === 'PROTECT' || input.currentProfile === 'AGGRESSIVE'
      ? input.currentProfile : 'NORMAL';
    // Guards : descente IMMÉDIATE vers baseline (sécurité, pas d'hystérésis).
    if (!input.live) return done(baseline, 'NORMAL', baseline, 'non-live');
    if (input.saveData) return done(baseline, 'NORMAL', baseline, 'save-data');
    if (!input.visible) return done(baseline, 'NORMAL', baseline, 'hidden');
    if (!input.online) return done(baseline, 'NORMAL', baseline, 'offline');
    if (input.fastStart) return done(baseline, 'NORMAL', baseline, 'fast-start');

    const need = rawNeed(input);
    const buf = typeof input.bufferAheadSec === 'number' && Number.isFinite(input.bufferAheadSec)
      ? Math.max(0, input.bufferAheadSec) : 0;
    // Stabilité démontrée = le buffer a effectivement atteint la cible
    // appliquée (preuve physique, pas temporelle).
    const stable = buf >= (Number.isFinite(input.currentTargetSec) && input.currentTargetSec > 0
      ? input.currentTargetSec : baseline);

    let next: PreloadProfile = cur;
    let reason = 'stable';
    if (need === 'HARD') {
      // Montée par paliers : jamais NORMAL→AGGRESSIVE direct.
      next = cur === 'NORMAL' ? 'PROTECT' : 'AGGRESSIVE';
      reason = cur === 'NORMAL' ? 'hard-escalate-protect' : 'hard-hold-escalate';
    } else if (need === 'SOFT') {
      // Fragilité : PROTECT est l'état refuge depuis n'importe quel profil
      // (montée depuis NORMAL, maintien, ou descente depuis AGGRESSIVE).
      next = 'PROTECT';
      reason = cur === 'AGGRESSIVE' ? 'soft-step-down' : cur === 'NORMAL' ? 'soft-escalate' : 'soft-hold';
    } else if (stable) {
      // Descente par paliers, jamais AGGRESSIVE→NORMAL direct.
      next = cur === 'AGGRESSIVE' ? 'PROTECT' : 'NORMAL';
      reason = cur === 'NORMAL' ? 'stable' : 'stable-step-down';
    } else {
      next = cur; // pas de besoin mais pas de preuve de stabilité : maintien
      reason = 'hold-no-proof';
    }
    const target = targetFor(baseline, next);
    return done(baseline, next, target, reason, input);
  } catch {
    // Inatteignable en pratique (entrées validées) : repli sûr = profil
    // NORMAL, cible conservée si valide, sinon 60 (médiane des baselines).
    const keep = Number.isFinite(input.currentTargetSec) && input.currentTargetSec > 0
      ? input.currentTargetSec : 60;
    return { profile: 'NORMAL', targetBufferSec: Math.min(PRELOAD_HARD_MAX_SEC, keep), reason: 'error-fallback', changed: false };
  }

  function done(
    baselineSec: number, profile: PreloadProfile, target: number, reason: string,
    src?: PreloadInput,
  ): PreloadDecision {
    const t = clampTarget(baselineSec, target);
    const prevProfile: PreloadProfile = src && (src.currentProfile === 'PROTECT' || src.currentProfile === 'AGGRESSIVE')
      ? src.currentProfile : 'NORMAL';
    const prevTarget = src && Number.isFinite(src.currentTargetSec) ? src.currentTargetSec : t;
    return { profile, targetBufferSec: t, reason, changed: profile !== prevProfile || t !== prevTarget };
  }
}
