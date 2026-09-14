// PeerManager — orchestration des liens WebRTC (maxPeers strict, §27 du brief).
//
// Le PeerManager ne choisit PAS la source finale d'un segment : il propose un
// ordre de candidats et expose `requestSegment` qui ESSAIE ≤ 2 pairs puis
// échoue proprement (le loader appellera l'origin). Scoring RÉEL (étape 5) :
// chaque lien porte un PeerScore (EWMA local, peer-score.ts). Sélection §21 :
// écarter invalides / cooldown / rid divergent / hors fenêtre → trier par
// score → rotation déterministe parmi les scores « équivalents » (diversité
// §23). Le coordinateur fournit des candidats ; LE CLIENT CHOISIT (spec §12).
// Pas de super-seeding, pas de multi-hop : hors périmètre (§40).

import { PeerLink, type AnnouncedWindow, type MeshPeerLinkState, type RtcEnv, type SegmentResult } from './peer-link';
import type { SegmentCache } from './memory-cache';
import { PeerScore, type PeerFailureKind } from './peer-score';
import type { MeshTrace } from './trace';
import type { MeshPeerSummary, MeshScoreConfig } from '@mbolo/contracts';
import { MESH_SCORE_DEFAULTS } from '@mbolo/contracts';

export interface SignalSink {
  send(type: 'SIGNAL_OFFER' | 'SIGNAL_ANSWER' | 'ICE_CANDIDATE', to: string, payload: { sdp?: string; c?: string[] }): void;
}

export interface PeerManagerOptions {
  selfPid: string;
  sid: string;
  rid: string | null;
  cache: SegmentCache;
  env: RtcEnv;
  signals: SignalSink;
  maxPeers: number;
  chunkBytes: number;
  peerTimeoutMs: number;
  /** Un pair échoué/retiré est remisé 10 min (ne pas retenter l'impossible). */
  cooldownMs?: number;
  /** Télémétrie POC (§46) : octets servis aux pairs / reçus des pairs. */
  onServed?(bytes: number): void;
  onDownloaded?(bytes: number): void;
  /** Horloge injectable (tests) — sinon Date.now. */
  now?: () => number;
  /** Override serveur du scoring (optionnel ; défaut = MESH_SCORE_DEFAULTS). */
  scoreConfig?: Partial<MeshScoreConfig>;
  /** Instrumentation [mesh-test] (§8) — absente = aucun coût. */
  trace?: MeshTrace;
}

interface Managed {
  link: PeerLink;
  cap: 'off' | 'low' | 'normal';
  win: AnnouncedWindow | null;
  failedAt: number | null;
  /** Score EWMA local de CE pair, côté DEMANDEUR (peer-score.ts). */
  score: PeerScore;
}

const UNRELIABLE_MS = 10 * 60_000;

export class PeerManager {
  private peers = new Map<string, Managed>();
  private chunkBytes: number;
  private peerTimeoutMs: number;
  private rid: string | null;
  private readonly now: () => number;
  private scoreConfig: Partial<MeshScoreConfig> | undefined;
  private selectionCursor = 0; // rotation déterministe de diversité (§23)
  maxPeers: number;

  constructor(private readonly opts: PeerManagerOptions) {
    this.chunkBytes = opts.chunkBytes;
    this.peerTimeoutMs = opts.peerTimeoutMs;
    this.rid = opts.rid;
    this.now = opts.now ?? ((): number => Date.now());
    this.scoreConfig = opts.scoreConfig;
    this.maxPeers = Math.max(0, Math.min(opts.maxPeers, 6));
  }

  /** Rendition active (rid) : les NOUVEAUX liens la portent. Un CHANGEMENT de
   *  rid (montée ABR) invalide TOUS les liens existants : leurs pairs peuvent
   *  servir des octets d'une autre rendition (mêmes (cc,sn), bytes différents —
   *  le pièce §30 du brief). On ferme tout ; le MeshClient re-JOIN et reçoit
   *  des candidats à jour (rid égaux ou null → HELLO cross-rendition garde-fou
   *  dans l'autre sens aussi). Coûteux mais rare : l'ABR ne switch pas en boucle. */
  setRid(rid: string | null): void {
    if (rid === this.rid) return;
    const changed = this.rid !== null && rid !== null; // premier réglage (null→X) : rien à jeter, les liens naissants portent déjà X
    this.rid = rid;
    if (changed) for (const managed of [...this.peers.values()]) this.dropLink(managed, 'rid-changed');
  }

  /** Reconfiguration à chaud depuis CONFIG du coordinateur (valeurs déjà
   *  bornées par le contrat serveur — impossible d'obtenir maxPeers=500). */
  reconfigure(cfg: { maxPeers?: number; chunkBytes?: number; peerTimeoutMs?: number; score?: Partial<MeshScoreConfig> }): void {
    if (typeof cfg.maxPeers === 'number') this.maxPeers = Math.max(0, Math.min(cfg.maxPeers, 6));
    if (typeof cfg.chunkBytes === 'number') this.chunkBytes = Math.max(16384, Math.min(cfg.chunkBytes, 65536));
    if (typeof cfg.peerTimeoutMs === 'number') this.peerTimeoutMs = Math.max(300, Math.min(cfg.peerTimeoutMs, 5000));
    if (cfg.score) {
      this.scoreConfig = { ...this.scoreConfig, ...cfg.score };
      for (const m of this.peers.values()) m.score.reconfigure(this.scoreConfig);
    }
  }

  /** Le coordinateur a livré des candidats : on crée les liens (≤ maxPeers). */
  applyCandidates(candidates: MeshPeerSummary[]): void {
    const wanted = candidates.filter((c) => c.id !== this.opts.selfPid && c.cap !== 'off');
    // On complète d'abord ; le remplacement d'un pair mort/pourri viendra à
    // l'événement `failed` (pas de churn perpétuel au rythme des JOIN).
    for (const candidate of wanted) {
      const existing = this.peers.get(candidate.id);
      if (existing) {
        // Le pair vit déjà : on rafraîchit SA FENÊTRE (c'est le sens d'un
        // PEER_JOINED window-update) — jamais de re-création de lien. Une
        // fenêtre qui AVANCE rajeunit la fraîcheur du score (§18) ; une fenêtre
        // qui ne bouge pas (pair muet) ne doit PAS le pénaliser ni le doper.
        if (candidate.win && (!existing.win || existing.win.last !== candidate.win.last || existing.win.cc !== candidate.win.cc)) {
          existing.win = candidate.win;
          existing.link.knownWin = candidate.win;
          existing.score.markWindowFresh();
        }
        if (existing.cap !== candidate.cap) { existing.cap = candidate.cap; existing.score.setCap(candidate.cap); }
        continue;
      }
      if (this.peers.size >= this.maxPeers) continue;
      if (this.inCooldown(candidate.id)) continue;
      this.addLink(candidate);
    }
  }

  private addLink(candidate: MeshPeerSummary): void {
    // Renditions connues et différentes = segments incompatibles : pas de lien.
    if (this.rid && candidate.rid && candidate.rid !== this.rid) return;
    const polite = this.opts.selfPid > candidate.id; // lexicographique : même calcul des deux côtés
    const link = new PeerLink(candidate.id, this.opts.sid, this.rid, polite, this.opts.cache, this.opts.env, {
      state: (state) => this.onLinkState(candidate.id, state),
      signal: (type, payload) => this.opts.signals.send(type, candidate.id, payload),
      served: (bytes) => this.opts.onServed?.(bytes),
      downloaded: (bytes) => this.opts.onDownloaded?.(bytes),
      trace: this.opts.trace,
    }, this.chunkBytes);
    this.peers.set(candidate.id, { link, cap: candidate.cap, win: candidate.win ?? null, failedAt: null, score: new PeerScore(candidate.id, candidate.cap, this.now, this.scoreConfig) });
    link.knownWin = candidate.win ?? null;
    if (candidate.win) this.peers.get(candidate.id)!.score.markWindowFresh();
    // Un seul initiateur par paire (roles complémentaires) : l'impoli ouvre
    // et offre ; le poli attend l'offer (canal via ondatachannel).
    if (!polite) link.initiate();
    else link.ensurePc();
  }

  private inCooldown(pid: string): boolean {
    const failedAt = this.cooldown.get(pid);
    return Boolean(failedAt && Date.now() - failedAt < (this.opts.cooldownMs ?? UNRELIABLE_MS));
  }

  onSignal(from: string, type: 'SIGNAL_OFFER' | 'SIGNAL_ANSWER' | 'ICE_CANDIDATE', payload: { sdp?: string; c?: string[] }): void {
    let managed = this.peers.get(from);
    if (!managed) {
      // L'offre d'un pair non demandé (il nous a vus en premier) : on l'accepte
      // si de la place, sinon on l'ignore — JAMAIS au-delà de maxPeers.
      if (type !== 'SIGNAL_OFFER' || this.peers.size >= this.maxPeers) return;
      managed = { link: this.buildUnasked(from), cap: 'normal', win: null, failedAt: null, score: new PeerScore(from, 'normal', this.now, this.scoreConfig) };
      this.peers.set(from, managed);
    }
    managed.link.receiveSignal(type, payload);
  }

  private buildUnasked(from: string): PeerLink {
    // On nous offre : on EST le côté répondeur. Jamais on n'initie ici (le
    // pair qui offre a, par construction, le rôle impoli de notre paire).
    const link = new PeerLink(from, this.opts.sid, this.rid, true, this.opts.cache, this.opts.env, {
      state: (state) => this.onLinkState(from, state),
      signal: (type, payload) => this.opts.signals.send(type, from, payload),
      served: (bytes) => this.opts.onServed?.(bytes),
      downloaded: (bytes) => this.opts.onDownloaded?.(bytes),
      trace: this.opts.trace,
    }, this.chunkBytes);
    link.ensurePc();
    return link;
  }

  /** Le pair a bougé sa fenêtre (HEARTBEAT reflet) : on mémorise (borne de demande §12). */
  updateWindow(pid: string, win: AnnouncedWindow | null): void {
    const managed = this.peers.get(pid);
    if (!managed) return;
    const advanced = win && (!managed.win || managed.win.last !== win.last || managed.win.cc !== win.cc);
    managed.win = win;
    managed.link.knownWin = win;
    if (advanced) managed.score.markWindowFresh();
  }

  private onLinkState(pid: string, state: MeshPeerLinkState): void {
    const managed = this.peers.get(pid);
    if (!managed) return;
    if (state === 'failed' || state === 'closed') {
      // ICE failed = échec de connectivité (souvent CGNAT) → cooldown long
      // (10 min) : on ne retente pas l'impossible en boucle. Les données
      // alimentent la décision TURN (§14 ADR). Le pair n'est pas « banni ».
      this.dropLink(managed, 'failed', true);
    }
  }

  private dropLink(managed: Managed, reason: string, cooldown = false): void {
    const pid = managed.link.pid;
    managed.link.close(reason);
    managed.score.dispose();
    this.peers.delete(pid);
    if (cooldown) this.cooldown.set(pid, Date.now());
  }
  private cooldown = new Map<string, number>();

  remove(pid: string): void {
    const managed = this.peers.get(pid);
    if (!managed) return;
    managed.link.close('removed');
    managed.score.dispose();
    this.peers.delete(pid);
  }

  get peerCount(): number { return [...this.peers.values()].filter((m) => m.link.usable).length; }
  get allPeers(): string[] { return [...this.peers.keys()]; }

  /** Meilleur score de pair USABLE maintenant (0 si aucun) — la garde de
   *  confiance du loader : sous `trustThreshold`, on ne parie pas, origin. */
  bestScore(): number {
    let best = 0;
    for (const m of this.peers.values()) {
      if (!m.link.usable || m.cap === 'off' || m.score.cooling) continue;
      const s = m.score.score();
      if (s > best) best = s;
    }
    return best;
  }

  /** RTT (ms) du lien USABLE le plus rapide, arrondi — pour le champ `rttMs`
   *  de STATS_REPORT (§28 brief : agrégé, jamais par pair). Effet de bord
   *  assumé et utile : chaque RTT observé alimente l'EWMA du pair. */
  fastestRttMs(): number | null {
    let best: number | null = null;
    for (const m of this.peers.values()) {
      if (!m.link.usable) continue;
      const rtt = m.link.rttMs;
      if (rtt == null) continue;
      m.score.recordRtt(rtt);
      if (best === null || rtt < best) best = rtt;
    }
    return best === null ? null : Math.min(10_000, Math.round(best));
  }

  /** Tentative P2P (§24 brief étape 5) : ≤ 2 pairs SÉQUENTIELS (jamais tous en
   *  parallèle — CPU/batterie/congestion bornés), instrumentée pour le score
   *  (durée réelle, succès, échec, RTT). Jamais bloquant : l'échec est un
   *  résultat, jamais une exception — le loader retombera origin. */
  async requestSegment(cc: number, sn: number): Promise<SegmentResult> {
    const now = this.now();
    for (const [pid, until] of this.cooldown) if (now - until > (this.opts.cooldownMs ?? UNRELIABLE_MS)) this.cooldown.delete(pid);
    const ranked = this.rank(cc, sn);
    if (!ranked.length) return { ok: false, reason: 'dead' };
    this.opts.trace?.({ t: 'selected', pid: ranked[0].link.pid, score: ranked[0].score.score(), cc, sn });
    for (const managed of ranked.slice(0, 2)) {
      const startedAt = this.now();
      const result = await managed.link.requestSegment(cc, sn, this.peerTimeoutMs);
      const durationMs = Math.max(1, this.now() - startedAt);
      this.opts.trace?.({ t: 'peerResult', pid: managed.link.pid, ok: result.ok, bytes: result.bytes?.length ?? 0, ms: durationMs, reason: result.reason });
      if (result.ok && result.bytes) {
        managed.score.recordSuccess(result.bytes.length, durationMs);
        if (managed.link.rttMs != null) managed.score.recordRtt(managed.link.rttMs);
        return result;
      }
      // Échec : classé souple/dur par peer-score (un 'unavailable' normal en
      // live ne condamne pas ; un 'timeout'/'hash' compte vers UNRELIABLE).
      managed.score.recordFailure((result.reason ?? 'timeout') as PeerFailureKind);
      if (result.reason === 'hash') managed.failedAt = now; // pair menteur → non fiable
    }
    return { ok: false, reason: ranked.length > 1 ? 'timeout' : (ranked[0] ? 'timeout' : 'dead') };
  }

  /** Sélection §21 : éliminer invalides / cooldown / rid divergent / hors
   *  fenêtre probable, TRIER par score décroissant, puis diversifier
   *  déterministement (§23) parmi les scores « équivalents » (à moins de
   *  `diversityEpsilon`) pour ne pas toujours pomper le même seeder. */
  private rank(cc: number, sn: number): Managed[] {
    const trace = this.opts.trace;
    const eligible: Managed[] = [];
    for (const managed of this.peers.values()) {
      if (!managed.link.usable) continue;                 // lien pas prêt
      if (managed.cap === 'off') { trace?.({ t: 'skipped', pid: managed.link.pid, why: 'cap-off' }); continue; } // ne sert pas (règle serveur doublée)
      if (managed.score.cooling) { trace?.({ t: 'skipped', pid: managed.link.pid, why: 'cooldown' }); continue; } // UNRELIABLE en cooldown (§14)
      if (this.inCooldown(managed.link.pid)) { trace?.({ t: 'skipped', pid: managed.link.pid, why: 'ice-cooldown' }); continue; } // ICE mort récemment (retrait local)
      if (managed.win && (managed.win.cc !== cc || sn < managed.win.first || sn > managed.win.last)) { trace?.({ t: 'skipped', pid: managed.link.pid, why: 'hors-fenetre' }); continue; } // hors fenêtre annoncée : §21 (ne demande pas ce qu'il n'a probablement pas)
      eligible.push(managed);
    }
    if (!eligible.length) return [];
    const scored = eligible.map((m) => ({ m, score: m.score.score(), rtt: m.link.rttMs ?? 9999 }));
    scored.sort((a, b) => b.score - a.score || a.rtt - b.rtt); // score d'abord, RTT arbitre en cas d'égalité stricte
    // Diversité déterministe : rotation à l'intérieur du plateau de scores
    // équivalents. `selectionCursor` n'est QUE fonction de l'histoire locale →
    // reproductible en test, aucune randomisation incontrôlée.
    const eps = (this.scoreConfig?.diversityEpsilon ?? MESH_SCORE_DEFAULTS.diversityEpsilon);
    const top = scored[0].score;
    const plateau = scored.filter((entry) => top - entry.score <= eps);
    if (plateau.length > 1) {
      this.selectionCursor = (this.selectionCursor + 1) % plateau.length;
      const chosen = plateau[this.selectionCursor];
      const rest = scored.filter((entry) => entry !== chosen);
      return [chosen, ...rest].map((entry) => entry.m); // l'élu du plateau d'abord, puis l'ordre par score
    }
    return scored.map((entry) => entry.m);
  }

  /** Suspends le seeding quand le client devient indisponible (batterie/
   *  background/réseau) : on ferme les liens d'émission, la lecture continue.
   *  Les SCORES sont jetés avec les liens (un lien rouvrira sur un pair neuf,
   *  donc un score neuf — pas de rancune à travers une coupure). */
  pauseSeeding(): void { for (const managed of this.peers.values()) { managed.link.close('paused'); managed.score.dispose(); } this.peers.clear(); }

  close(): void {
    for (const managed of this.peers.values()) { managed.link.close('shutdown'); managed.score.dispose(); }
    this.peers.clear();
  }
}
