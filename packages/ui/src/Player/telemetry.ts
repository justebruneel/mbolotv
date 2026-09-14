// Façade de télémétrie du Player (@mbolo/ui) — agrégation SANS comportement.
//
// Le Player et MeshStream produisent déjà leurs métriques (sessionLog,
// MeshStats) ; cette façade les EXPOSE sous un format commun, elle ne crée
// aucun second système de mesure et ne pilote rien. Toutes les méthodes sont
// no-throw par construction (jamais un compteur ne casse la lecture) et
// n'allouent qu'un objet borné (compteurs par type d'erreur plafonnés).
//
// Champs §14 : startupMs, startupSuccess, bufferAheadSec, rebufferCount,
// rebufferDurationMs, throughputMbps (EWMA), bitrate, quality,
// qualityChanges, latencySec, sourceChanges, errors, fallbacks, networkType +
// mesh (peerHits, peerBytes, originBytes, offload, peerHitRate) via reader.

export type BufferLevel = 'CRITICAL' | 'LOW' | 'NORMAL' | 'COMFORTABLE';

/** Borne dure du journal de session Player (mémoire des longues sessions :
 *  on conserve les entrées RÉCENTES, les anciennes sont évincées). */
export const MAX_PLAYER_LOG_ENTRIES = 500;

/** Ajout borné : pousse puis évince les plus anciennes au-delà de max.
 *  Retourne la liste (mutée en place, jamais de throw). */
export function appendBounded<T>(list: T[], item: T, max: number = MAX_PLAYER_LOG_ENTRIES): T[] {
  try {
    list.push(item);
    if (list.length > max) list.splice(0, list.length - max);
  } catch { /* ignore */ }
  return list;
}

export interface CappedLevel { index: number; height: number }

export interface LevelCaps {
  /** Plafond réseau (-1 = aucun) : plus haut niveau ≤ capHeight du profil. */
  networkCap: number;
  /** Plafond Éco 480p (toujours défini si niveaux non vides). */
  dataCap: number;
  /** Plafond effectif : dataSaver ? min(network,data) : network. */
  baseCap: number;
}

/** Calcul PUR des plafonds ABR — EXACTEMENT la formule du Player
 *  (MANIFEST_PARSED + effet dataSaver) : `networkCap = capHeight==null ? -1
 *  : max(0, ...niveaux ≤ capHeight)`, `dataCap = max(0, ...niveaux ≤ 480)`,
 *  `baseCap = dataSaver ? min(networkCap<0?dataCap:networkCap, dataCap)
 *  : networkCap`. Niveaux vides → baseCap -1 (aucun plafond applicable).
 *  Utilisé par le handler connection.change SANS recréer hls.js. */
export function computeLevelCaps(
  levels: CappedLevel[],
  dataSaver: boolean,
  capHeight: number | null,
  dataSaverMaxHeight = 480,
): LevelCaps {
  try {
    if (!Array.isArray(levels) || levels.length === 0) return { networkCap: -1, dataCap: -1, baseCap: -1 };
    const networkCap = capHeight == null
      ? -1
      : Math.max(0, ...levels.filter((l) => l.height <= capHeight).map((l) => l.index));
    const dataCap = Math.max(0, ...levels.filter((l) => l.height <= dataSaverMaxHeight).map((l) => l.index));
    const baseCap = dataSaver
      ? Math.min(networkCap < 0 ? dataCap : networkCap, dataCap)
      : networkCap;
    return { networkCap, dataCap, baseCap };
  } catch {
    return { networkCap: -1, dataCap: -1, baseCap: -1 };
  }
}

/** Niveau de buffer relatif au seuil critique (politique §4) :
 *  CRITICAL < critique (priorité absolue téléchargement) ;
 *  LOW < 1.5× ; NORMAL < 2× ; COMFORTABLE ≥ 2× (travaux secondaires OK).
 *  Seuil invalide (≤ 0) : CRITICAL si vide, NORMAL sinon — jamais d'exception. */
export function bufferLevel(bufferAheadSec: number, criticalSec: number): BufferLevel {
  const len = Number.isFinite(bufferAheadSec) ? Math.max(0, bufferAheadSec) : 0;
  if (!(criticalSec > 0)) return len <= 0 ? 'CRITICAL' : 'NORMAL';
  if (len < criticalSec) return 'CRITICAL';
  if (len < criticalSec * 1.5) return 'LOW';
  if (len < criticalSec * 2) return 'NORMAL';
  return 'COMFORTABLE';
}

export interface NetworkEstimate {
  /** Un transfert observé (jamais de sonde artificielle, §6). */
  observe(bytes: number, durationMs: number): void;
  /** Débit EWMA en Mbps, null sans mesure. Distinct du score MeshStream. */
  throughputMbps(): number | null;
  samples(): number;
  reset(): void;
}

/** Estimation EWMA du débit lecteur (α=0.3, premier échantillon = mesure
 *  brute). Ignore les mesures invalides (0/négatif/NaN) : pas de
 *  division par zéro, pas de NaN propagé. */
export function createNetworkEstimate(alpha = 0.3): NetworkEstimate {
  const a = alpha > 0 && alpha < 1 ? alpha : 0.3;
  let ewmaBps: number | null = null;
  let n = 0;
  return {
    observe(bytes: number, durationMs: number): void {
      try {
        if (!(bytes > 0) || !(durationMs > 0)) return;
        const bps = (bytes * 1000) / durationMs;
        if (!Number.isFinite(bps) || bps <= 0) return;
        ewmaBps = ewmaBps == null ? bps : a * bps + (1 - a) * ewmaBps;
        n += 1;
      } catch { /* jamais bloquant */ }
    },
    throughputMbps(): number | null {
      try {
        return ewmaBps == null ? null : (ewmaBps * 8) / 1_000_000;
      } catch { return null; }
    },
    samples(): number { return n; },
    reset(): void { ewmaBps = null; n = 0; },
  };
}

export interface MeshTelemetrySample {
  peerHits: number;
  originHits: number;
  peerBytes: number;
  originBytes: number;
}

export interface PlayerTelemetrySnapshot {
  startupMs: number | null;
  startupSuccess: boolean | null;
  /** Mesures de démarrage fin (null = non mesuré, jamais simulé) : manifest
   *  parsé, premier segment chargé, première image (playing + buffer > 0). */
  manifestMs: number | null;
  firstSegmentMs: number | null;
  firstFrameMs: number | null;
  bufferAheadSec: number;
  rebufferCount: number;
  rebufferDurationMs: number;
  throughputMbps: number | null;
  bitrate: number | null;
  quality: string | null;
  qualityChanges: number;
  /** Sens des changements (hauteur connue uniquement ; sinon changement
   *  simple) — permet de détecter les oscillations ABR sans toucher l'ABR. */
  upSwitchCount: number;
  downSwitchCount: number;
  latencySec: number | null;
  sourceChanges: number;
  errors: Array<{ type: string; count: number }>;
  fallbacks: number;
  networkType: string | null;
  mesh: (MeshTelemetrySample & { offload: number; peerHitRate: number }) | null;
}

const MAX_ERROR_TYPES = 12;

export interface PlayerTelemetry {
  recordStartup(durationMs: number | null, success: boolean): void;
  recordManifest(durationMs: number | null): void;
  recordFirstSegment(durationMs: number | null): void;
  recordFirstFrame(durationMs: number | null): void;
  setBufferAhead(sec: number): void;
  rebufferStart(): void;
  rebufferEnd(): void;
  observeTransfer(bytes: number, durationMs: number): void;
  setBitrate(bps: number | null): void;
  recordQuality(label: string, heightPx?: number | null): void;
  setLatency(sec: number | null): void;
  recordSourceChange(): void;
  recordError(type: string | null): void;
  recordFallback(): void;
  setNetworkType(t: string | null): void;
  attachMeshReader(reader: (() => MeshTelemetrySample | null) | null): void;
  snapshot(): PlayerTelemetrySnapshot;
  reset(): void;
}

export function createPlayerTelemetry(now: () => number = () => Date.now()): PlayerTelemetry {
  let startupMs: number | null = null;
  let startupSuccess: boolean | null = null;
  let bufferAheadSec = 0;
  let rebufferCount = 0;
  let rebufferDurationMs = 0;
  let rebufferSince: number | null = null;
  let bitrate: number | null = null;
  let quality: string | null = null;
  let qualityChanges = 0;
  let upSwitchCount = 0;
  let downSwitchCount = 0;
  let lastHeightPx: number | null = null;
  let manifestMs: number | null = null;
  let firstSegmentMs: number | null = null;
  let firstFrameMs: number | null = null;
  let latencySec: number | null = null;
  let sourceChanges = 0;
  let fallbacks = 0;
  let networkType: string | null = null;
  const errors = new Map<string, number>();
  const net = createNetworkEstimate();
  let meshReader: (() => MeshTelemetrySample | null) | null = null;
  const safeNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

  return {
    recordStartup(durationMs, success) {
      try {
        if (startupMs != null) return; // premier appel gagne (démarrage unique par source)
        const d = safeNum(durationMs);
        if (d != null) startupMs = d;
        startupSuccess = success;
      } catch { /* no-op */ }
    },
    // Étapes fines du démarrage (first-wins, null si jamais observé — la
    // façade ne simule aucune valeur, §14/§15).
    recordManifest(durationMs) {
      try { if (manifestMs == null) { const d = safeNum(durationMs); if (d != null) manifestMs = d; } } catch { /* no-op */ }
    },
    recordFirstSegment(durationMs) {
      try { if (firstSegmentMs == null) { const d = safeNum(durationMs); if (d != null) firstSegmentMs = d; } } catch { /* no-op */ }
    },
    recordFirstFrame(durationMs) {
      try { if (firstFrameMs == null) { const d = safeNum(durationMs); if (d != null) firstFrameMs = d; } } catch { /* no-op */ }
    },
    setBufferAhead(sec) {
      try { bufferAheadSec = safeNum(sec) ?? 0; } catch { /* no-op */ }
    },
    rebufferStart() {
      try {
        if (rebufferSince != null) return; // déjà en stall : pas de double compte
        rebufferSince = now();
        rebufferCount += 1;
      } catch { /* no-op */ }
    },
    rebufferEnd() {
      try {
        if (rebufferSince == null) return;
        rebufferDurationMs += Math.max(0, now() - rebufferSince);
        rebufferSince = null;
      } catch { /* no-op */ }
    },
    observeTransfer(bytes, durationMs) { net.observe(bytes, durationMs); },
    setBitrate(bps) {
      try { bitrate = safeNum(bps); } catch { /* no-op */ }
    },
    recordQuality(label, heightPx) {
      try {
        const next = String(label ?? '').slice(0, 32) || null;
        if (next !== quality) {
          if (quality !== null) {
            qualityChanges += 1;
            // Sens mesuré uniquement si les deux hauteurs sont connues et
            // différentes ; sinon simple changement (jamais d'invention).
            const prev = lastHeightPx;
            const cur = typeof heightPx === 'number' && Number.isFinite(heightPx) ? heightPx : null;
            if (prev != null && cur != null && cur !== prev) {
              if (cur > prev) upSwitchCount += 1;
              else downSwitchCount += 1;
            }
          }
          quality = next;
          if (typeof heightPx === 'number' && Number.isFinite(heightPx)) lastHeightPx = heightPx;
          else if (next === null) lastHeightPx = null;
        }
      } catch { /* no-op */ }
    },
    setLatency(sec) {
      try { latencySec = safeNum(sec); } catch { /* no-op */ }
    },
    recordSourceChange() {
      try { sourceChanges += 1; } catch { /* no-op */ }
    },
    recordError(type) {
      try {
        const key = String(type ?? 'unknown').slice(0, 64) || 'unknown';
        if (!errors.has(key) && errors.size >= MAX_ERROR_TYPES) return; // borné
        errors.set(key, (errors.get(key) ?? 0) + 1);
      } catch { /* no-op */ }
    },
    recordFallback() {
      try { fallbacks += 1; } catch { /* no-op */ }
    },
    setNetworkType(t) {
      try { networkType = typeof t === 'string' && t ? t.slice(0, 32) : null; } catch { /* no-op */ }
    },
    attachMeshReader(reader) {
      try { meshReader = reader; } catch { /* no-op */ }
    },
    snapshot() {
      try {
        let mesh: PlayerTelemetrySnapshot['mesh'] = null;
        try {
          const s = meshReader?.();
          if (s) {
            const peerSeg = Math.max(0, s.peerHits || 0) + Math.max(0, s.originHits || 0);
            const peerB = Math.max(0, s.peerBytes || 0) + Math.max(0, s.originBytes || 0);
            mesh = {
              peerHits: s.peerHits, originHits: s.originHits,
              peerBytes: s.peerBytes, originBytes: s.originBytes,
              offload: peerB === 0 ? 0 : Math.max(0, s.peerBytes || 0) / peerB,
              peerHitRate: peerSeg === 0 ? 0 : Math.max(0, s.peerHits || 0) / peerSeg,
            };
          }
        } catch { mesh = null; }
        return {
          startupMs, startupSuccess, manifestMs, firstSegmentMs, firstFrameMs,
          bufferAheadSec, rebufferCount, rebufferDurationMs,
          throughputMbps: net.throughputMbps(), bitrate, quality, qualityChanges,
          upSwitchCount, downSwitchCount,
          latencySec, sourceChanges,
          errors: [...errors.entries()].map(([type, count]) => ({ type, count })),
          fallbacks, networkType, mesh,
        };
      } catch {
        return {
          startupMs: null, startupSuccess: null, manifestMs: null,
          firstSegmentMs: null, firstFrameMs: null,
          bufferAheadSec: 0, rebufferCount: 0,
          rebufferDurationMs: 0, throughputMbps: null, bitrate: null, quality: null,
          qualityChanges: 0, upSwitchCount: 0, downSwitchCount: 0,
          latencySec: null, sourceChanges: 0, errors: [],
          fallbacks: 0, networkType: null, mesh: null,
        };
      }
    },
    reset() {
      try {
        startupMs = null; startupSuccess = null;
        manifestMs = null; firstSegmentMs = null; firstFrameMs = null;
        bufferAheadSec = 0;
        rebufferCount = 0; rebufferDurationMs = 0; rebufferSince = null;
        bitrate = null; quality = null; qualityChanges = 0;
        upSwitchCount = 0; downSwitchCount = 0; lastHeightPx = null;
        latencySec = null;
        sourceChanges = 0; fallbacks = 0; networkType = null;
        errors.clear(); net.reset();
      } catch { /* no-op */ }
    },
  };
}
