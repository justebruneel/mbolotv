// ============================================================================
// peer-score.ts — Scoring local des pairs MeshStream (étape 5).
//
// Décision d'architecture (spec §12, brief §10) : le COORDINATEUR fournit des
// candidats, le CLIENT choisit. Ce module est purement local : rien n'est
// envoyé au serveur ici (les seules statistiques remontées sont agrégées et
// passent par STATS_REPORT, côté MeshClient). Aucune donnée personnelle,
// aucune IP, aucun token dans un score.
//
// Philosophie (brief §49) : « Origin-first reliability, P2P opportuniste ».
// Un score n'est jamais une raison de RETENIR la lecture : il ordonne des
// candidats, il ne remplace pas l'origin. Un pair parfait qui met 3 s à
// répondre reste perdant face à l'origin si le buffer est bas — la garde de
// buffer est STRUCTURELLE (loader), ce score ne la contourne pas.
//
// Six facteurs, chacun ramené dans [0..1] avant combinaison (les poids n'ont
// pas à sommer à 1, la normalisation protège contre un facteur dominateur) :
//   success    taux de succès EWMA (le pair LIVRE-t-il vraiment ?)
//   throughput débit observé EWMA, en bytes/s, aplati par une sigmoïde douce
//   rtt        inverse du RTT EWMA (le pair RÉPOND-il vite ?)
//   freshness  âge de la fenêtre annoncée (a-t-il encore le live edge ?)
//   upload     capacité déclarée du pair à servir (off → 0, low → 0.5, normal → 1)
//   stability  absence d'échecs récents (un pair qui vient de tomber → 0)
//
// EWMA = exponential weighted moving average. Un seul transfert n'est JAMAIS
// la vérité (§16) : la moyenne converge progressivement. Un pair à 8 Mbps
// puis 1 Mbps puis 5 Mbps donne un score qui suit la TENDANCE, pas le dernier
// pic.
// ============================================================================
import { MESH_SCORE_DEFAULTS, type MeshScoreConfig } from '@mbolo/contracts';

export type PeerFailureKind = 'timeout' | 'refused' | 'hash' | 'dead' | 'overloaded' | 'unavailable';

/** Les échecs DURS (le pair n'a pas su/pu livrer ce qu'il annonçait) comptent
 *  vers UNRELIABLE. Les échecs SOUPLES (overloaded = il est occupé ;
 *  unavailable = il n'a plus ce segment, normal en live) ne sanctionnent PAS
 *  la fiabilité : ils coûtent seulement le score de l'instant. Un pair
 *  débordé n'est pas un pair pourri — le sur-pénaliser vide le swarm. */
const HARD_FAILURES: ReadonlySet<PeerFailureKind> = new Set<PeerFailureKind>(['timeout', 'hash', 'dead']);
const VERY_HARD: ReadonlySet<PeerFailureKind> = new Set<PeerFailureKind>(['hash']); // un pair menteur (sha faux) = 2 échecs durs

export interface PeerScoreSample {
  ok: boolean;
  bytes?: number;
  durationMs?: number;
  failure?: PeerFailureKind;
}

/** Facteurs normalisés [0..1] d'un pair, à un instant t. */
export interface PeerScoreFactors {
  success: number;
  throughput: number;
  rtt: number;
  freshness: number;
  upload: number;
  stability: number;
}

/** État observable exposé au PeerManager et à la télémétrie. */
export interface PeerScoreSnapshot {
  score: number;
  state: 'unknown' | 'healthy' | 'degraded' | 'unreliable';
  reliable: boolean; // utilisable maintenant (pas en cooldown)
  coolingUntil: number; // 0 = pas de cooldown
  consecutiveFailures: number;
  successRate: number;
  throughputBps: number | null;
  rttMs: number | null;
  windowFreshAt: number; // 0 = inconnue
}

/** Le niveau d'upload autorisé d'un pair → facteur [0..1]. */
function uploadFactor(cap: 'off' | 'low' | 'normal'): number {
  return cap === 'normal' ? 1 : cap === 'low' ? 0.5 : 0;
}

/** Sigmoïde douce du débit : 0 à 0, ~0.5 à ~1 Mbps, ~1 au-delà de ~5 Mbps.
 *  Un pair à 40 Mbps ne domine PAS un pair à 6 Mbps (plateau) — on veut du
 *  « suffisant », pas « le plus rapide du monde à tout prix » (règle §17 :
 *  RTT/débit ne sont jamais l'unique critère). */
function throughputFactor(bps: number | null): number {
  if (!bps || bps <= 0) return 0.5; // inconnu : neutre, pas zéro (un pair jamais testé n'est pas lent)
  // sigmoïde centrée ~2 Mbps, pente ~1/3 Mbps
  const x = (bps / 1_000_000 - 2) / 1.5;
  return 1 / (1 + Math.exp(-x));
}

/** RTT → facteur [0..1] : 0 ms → 1, 500 ms → ~0.5, plafond dur 2 s. */
function rttFactor(rttMs: number | null): number {
  if (rttMs == null) return 0.5; // inconnu : neutre
  const clamped = Math.max(0, Math.min(rttMs, 2000));
  return 1 - clamped / 2000;
}

/** Fraîcheur d'une fenêtre annoncée : pleine valeur jusqu'à windowStaleMs/3,
 *  linéairement décroissante ensuite, 0 au-delà de windowStaleMs. Une fenêtre
 *  vieille n'a plus le live edge (§18) : ne pas la traiter comme un seeder. */
function freshnessFactor(winFreshAt: number, now: number, windowStaleMs: number): number {
  if (winFreshAt <= 0) return 0; // aucune fenêtre annoncée : on ne sait pas ce qu'il a
  const age = Math.max(0, now - winFreshAt);
  if (age >= windowStaleMs) return 0;
  const full = windowStaleMs / 3;
  if (age <= full) return 1;
  return 1 - (age - full) / (windowStaleMs - full);
}

/**
 * Le score d'UN pair. Instancié par lien dans le PeerManager ; ne connaît que
 * ses propres observations (jamais d'état global, jamais de réseau).
 */
export class PeerScore {
  private alpha: number;
  private cfg: MeshScoreConfig;
  private successEwma: number | null = null; // EWMA du taux de succès (0/1 par échantillon)
  private throughputEwma: number | null = null; // EWMA bytes/s
  private rttEwma: number | null = null; // EWMA ms
  private winFreshAt = 0; // dernier rafraîchissement connu de la fenêtre annoncée
  private consecutiveHard = 0;
  private recentHardAt: number[] = []; // horodatages des derniers échecs durs (fenêtre de « rapprochés »)
  private successfulRequests = 0;
  private failedRequests = 0;
  private bytesDownloaded = 0;
  private connectedSince = 0;
  private coolingUntil = 0;
  private cooldownEscalation = 1; // multiplié à chaque rechute (§15 auto-cicatrisant)
  private disposed = false;

  constructor(
    readonly pid: string,
    private cap: 'off' | 'low' | 'normal',
    private readonly now: () => number = () => Date.now(),
    config?: Partial<MeshScoreConfig>,
  ) {
    this.cfg = { ...MESH_SCORE_DEFAULTS, ...config, weights: { ...MESH_SCORE_DEFAULTS.weights, ...config?.weights } };
    this.alpha = this.cfg.alpha;
    this.connectedSince = this.now();
  }

  /** Changement de capacité à chaud (le pair annonce un changement de cap) :
   *  on CONSERVE l'historique du score, seul le facteur `upload` bouge. */
  setCap(cap: 'off' | 'low' | 'normal'): void { this.cap = cap; }

  /** Reconfiguration à chaud (le serveur pousse un override de `score`). */
  reconfigure(config?: Partial<MeshScoreConfig>): void {
    if (!config) return;
    this.cfg = { ...this.cfg, ...config, weights: { ...this.cfg.weights, ...config?.weights } };
    this.alpha = this.cfg.alpha;
  }

  /** Un transfert réussi : met à jour succès, débit, et rétablit la confiance. */
  recordSuccess(bytes: number, durationMs: number): void {
    if (this.disposed) return;
    const t = this.now();
    this.successfulRequests += 1;
    this.consecutiveHard = 0; // un succès « réinitialise » la condamnation (§15)
    this.coolingUntil = 0;
    this.cooldownEscalation = 1;
    this.successEwma = this.ewma(this.successEwma, 1);
    if (durationMs > 0 && bytes > 0) {
      const bps = (bytes * 1000) / durationMs;
      this.throughputEwma = this.ewma(this.throughputEwma, bps);
      this.bytesDownloaded += bytes;
    }
    void t;
  }

  /** Un transfert échoué. Les échecs souples coûtent le score mais ne
   *  condamnent pas ; les durs comptent vers UNRELIABLE + cooldown. */
  recordFailure(kind: PeerFailureKind): void {
    if (this.disposed) return;
    this.failedRequests += 1;
    const weight = VERY_HARD.has(kind) ? 2 : 1;
    if (HARD_FAILURES.has(kind)) {
      this.consecutiveHard += weight;
      this.recentHardAt.push(this.now());
      // purge des échecs hors de la fenêtre « rapprochés » (5 min)
      const cutoff = this.now() - 300_000;
      this.recentHardAt = this.recentHardAt.filter((t) => t >= cutoff);
      if (this.consecutiveHard >= this.cfg.unreliableAfter) {
        this.coolingUntil = this.now() + this.cfg.cooldownMs * this.cooldownEscalation;
        this.cooldownEscalation = Math.min(this.cooldownEscalation * this.cfg.cooldownEscalation, 4);
      }
    }
    this.successEwma = this.ewma(this.successEwma, 0);
  }

  /** RTT applicatif (PONG) observé sur le lien. Alimente le facteur rtt. */
  recordRtt(rttMs: number): void {
    if (this.disposed) return;
    this.rttEwma = this.ewma(this.rttEwma, Math.max(0, rttMs));
  }

  /** Le pair a rafraîchi sa fenêtre annoncée (PEER_JOINED / heartbeat reflet). */
  markWindowFresh(): void {
    if (!this.disposed) this.winFreshAt = this.now();
  }

  /** L'annonce n'a PAS bougé (pair muet) : ne rajeunit pas la fraîcheur. */
  get windowFreshAt(): number { return this.winFreshAt; }

  /** EWMA unifiée : premier échantillon = valeur brute (pas de biais 0). */
  private ewma(prev: number | null, sample: number): number {
    return prev == null ? sample : this.alpha * sample + (1 - this.alpha) * prev;
  }

  /** Le pair est-il utilisable MAINTENANT (hors cooldown) ? Un pair en
   *  cooldown ne doit plus être sélectionné (§14) mais n'est pas supprimé :
   *  il redeviendra testable après son délai. */
  get reliable(): boolean { return this.now() >= this.coolingUntil; }

  get cooling(): boolean { return this.now() < this.coolingUntil; }

  /** Facteurs normalisés courants (exposés pour la télémétrie/debug). */
  factors(): PeerScoreFactors {
    const now = this.now();
    const stability = this.stabilityFactor(now);
    return {
      success: this.successEwma ?? 0.6, // pair jamais testé : légèrement confiant (on lui laisse sa chance)
      throughput: throughputFactor(this.throughputEwma),
      rtt: rttFactor(this.rttEwma),
      freshness: freshnessFactor(this.winFreshAt, now, this.cfg.windowStaleMs),
      upload: uploadFactor(this.cap),
      stability,
    };
  }

  /** Score global pondéré dans [0..1]. Les poids sont appliqués tels quels
   *  puis divisés par leur somme → normalisation : aucun facteur ne domine. */
  score(): number {
    if (this.cap === 'off') return 0; // un pair off ne sert jamais : score nul, jamais sélectionné comme seeder
    if (this.cooling) return 0;
    const f = this.factors();
    const w = this.cfg.weights;
    const weightSum = w.success + w.throughput + w.rtt + w.freshness + w.upload + w.stability;
    if (weightSum <= 0) return 0;
    const raw =
      w.success * f.success +
      w.throughput * f.throughput +
      w.rtt * f.rtt +
      w.freshness * f.freshness +
      w.upload * f.upload +
      w.stability * f.stability;
    return Math.max(0, Math.min(1, raw / weightSum));
  }

  /** Stabilité = pas d'échecs durs récents + lien connecté durablement. Deux
   *  échecs « rapprochés » réduisent la stabilité (§14) sans la tuer. */
  private stabilityFactor(now: number): number {
    if (this.recentHardAt.length === 0) return 1;
    const recent = this.recentHardAt.filter((t) => now - t < 120_000).length;
    const base = Math.max(0, 1 - recent * 0.35);
    // un pair resté connecté longtemps sans faillir regagne de la stabilité
    const uptimeMin = (now - this.connectedSince) / 60_000;
    const recovery = Math.min(0.15, uptimeMin * 0.02);
    return Math.min(1, base + recovery);
  }

  state(): PeerScoreSnapshot['state'] {
    if (this.cooling) return 'unreliable';
    const s = this.score();
    if (this.successEwma == null) return 'unknown';
    if (s >= 0.55) return 'healthy';
    return 'degraded';
  }

  snapshot(): PeerScoreSnapshot {
    return {
      score: this.score(),
      state: this.state(),
      reliable: this.reliable,
      coolingUntil: this.coolingUntil,
      consecutiveFailures: this.consecutiveHard,
      successRate: this.successEwma ?? 0,
      throughputBps: this.throughputEwma,
      rttMs: this.rttEwma,
      windowFreshAt: this.winFreshAt,
    };
  }

  /** Compteurs agrégés pour STATS_REPORT (§28/§29 — agrégés, jamais détaillés). */
  counters(): { ok: number; fail: number; bytes: number } {
    return { ok: this.successfulRequests, fail: this.failedRequests, bytes: this.bytesDownloaded };
  }

  dispose(): void { this.disposed = true; }
}
