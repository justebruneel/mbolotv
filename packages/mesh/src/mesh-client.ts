// MeshClient — le client MeshStream (étape 4 POC).
//
// Cycle de vie : start(meshToken, meshUrl, manifestUrl, levelUrl?) → JOIN via
// le signaling (WS, repli poll) → candidats → liens WebRTC (PeerManager) →
// heartbeat de fenêtre. requestSegment est le point d'entrée du loader ;
// seedOriginSegment alimente le cache quand un segment arrive de l'origin.
//
// Ce client NE CONNAÎT PAS : SQL, DeviceGrant, fournisseurs IPTV, credentials.
// Il ne reçoit que le jeton opaque et l'URL du coordinateur (spec §4).
//
// Toutes les décisions « ne pas faire » sont structurales : si le mesh tombe
// (coordinateur, WS, ICE, pairs), requestSegment échoue et le loader appelle
// l'origin — la lecture n'attend jamais le mesh (règle n°1 de l'étape 4).

import { MESH_PROTOCOL_VERSION, MESH_SCORE_DEFAULTS, meshCoordinatorMessageSchema, type MeshConfig, type MeshPeerSummary } from '@mbolo/contracts';
import { SegmentCache } from './memory-cache';
import { PersistentCache, type SegmentStore } from './persistent-cache';
import { PeerManager, type SignalSink } from './peer-manager';
import { derivePollBase, Signaling, type SignalingTransport } from './signaling';
import type { RtcEnv } from './peer-link';
import type { MeshTrace } from './trace';

export interface MeshClientOptions {
  token: string;
  meshUrl: string;            // wss(s)://…/mesh/ws
  levelUrl: string;           // URL du manifest de rendition — SEULE source de l'identité de flux
  selfPid: string;
  swarmId: string;            // fourni par le serveur via le jeton (le client ne le calcule pas)
  capacity: 'off' | 'low' | 'normal';
  networkType: 'wifi' | 'cellular' | 'wired' | 'unknown';
  env: RtcEnv;
  fetchImpl?: typeof fetch;
  wsFactory?: (url: string) => WebSocket;
  now?: () => number;
  metrics?: MeshMetrics;
  /** Store persistant injecté (tests : InMemoryStore). Absent → IndexedDB
   *  navigateur, ou no-op si IndexedDB indisponible. */
  persistentStore?: SegmentStore;
  /** Plafond d'uploads servis simultanés (tous liens, §9) — défaut 2.
   *  Conservateur : jamais un client-relais. */
  maxUploads?: number;
  /** Instrumentation [mesh-test] (§8) — absente = aucun coût. */
  trace?: MeshTrace;
}

export interface MeshMetrics {
  attempt(): void; success(bytes: number): void; timeout(): void; hashFail(): void;
  fallbackOrigin(): void; bytesReceived(n: number): void; bytesServed(n: number): void;
  webrtcOk(): void; webrtcFail(): void; peers(n: number): void;
  /** Télémétrie étape 5 (§28) — OPTIONNELLE (les callers existants les ignorent). */
  bytesFromOrigin?(n: number): void; bytesFromMemory?(n: number): void; bytesFromIndexedDB?(n: number): void;
  peerFailure?(reason: string): void;
}

export const NOOP_METRICS: MeshMetrics = { attempt() {}, success() {}, timeout() {}, hashFail() {}, fallbackOrigin() {}, bytesReceived() {}, bytesServed() {}, webrtcOk() {}, webrtcFail() {}, peers() {}, bytesFromOrigin() {}, bytesFromMemory() {}, bytesFromIndexedDB() {}, peerFailure() {} };

export class MeshClient {
  readonly cache: SegmentCache;
  readonly persist: PersistentCache;
  readonly peerManager: PeerManager;
  private signaling: SignalingTransport | null = null;
  private cfg: MeshConfig | null = null;
  private seq = 0;
  private rid: string | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  readonly metrics: MeshMetrics;
  private started = false;
  private disposed = false;
  /** Kill-switch PAUSE (étape 5) : p2pEnabled=false ferme les liens et stoppe
   *  les demandes SANS tuer la session — le re-JOIN à true est possible sans
   *  recharger la page. La lecture continue (le loader retombe origin). */
  private paused = false;
  /** Compteurs agrégés pour STATS_REPORT (deltas depuis le dernier report). */
  private statsDelta = { upBytes: 0, peerDlBytes: 0, peerOk: 0, peerFail: 0 };
  private lastStatsAt = 0;
  private lastFallbackPingAt = 0;
  /** Backoff adaptatif (§25 brief) : après `backoffAfter` échecs pair
   *  consécutifs, on cesse de PARIER sur le mesh pendant `backoffMs` (origin
   *  direct) — la lecture n'attend jamais un mesh qui vient de prouver qu'il
   *  ne livre pas. Un succès remet le compteur à zéro. */
  private consecutivePeerFails = 0;
  private backoffUntil = 0;
  /** Requêtes en vol par segment (request coalescing §15) : clé `cc:sn` —
   *  le client ne vit que dans UN swarm, c'est l'identité complète. Deux
   *  appels simultanés pour le même segment PARTAGENT le même transfert
   *  (jamais de double téléchargement), y compris loader ↔ prefetch. La
   *  promesse ne rejette jamais ; cleanup garanti par finally. */
  private readonly inflight = new Map<string, Promise<{ ok: boolean; bytes?: Uint8Array; reason?: string }>>();

  constructor(private readonly opts: MeshClientOptions) {
    this.capacity = opts.capacity;
    this.cache = new SegmentCache(opts.swarmId, 80); // budget mémoire v1 : ~80 segments max (≈ 4 min à 4 s/seg en 1 Mbps)
    this.persist = new PersistentCache({ swarmId: opts.swarmId, store: opts.persistentStore, now: opts.now });
    const signals: SignalSink = {
      send: (type, to, payload) => this.up(type, { to, ...payload } as Record<string, unknown>),
    };
    this.metrics = opts.metrics ?? NOOP_METRICS;
    this.peerManager = new PeerManager({
      selfPid: opts.selfPid, sid: opts.swarmId, rid: null, cache: this.cache,
      env: opts.env, signals, maxPeers: 4, chunkBytes: 65536, peerTimeoutMs: 1500,
      maxUploads: opts.maxUploads, now: opts.now, trace: opts.trace,
      onServed: (bytes) => { this.metrics.bytesServed(bytes); this.statsDelta.upBytes += bytes; },
      onDownloaded: () => undefined, // octets déjà comptés dans requestSegment
    });
  }

  setRid(rid: string | null): void {
    if (rid === this.rid) return;
    // Montée/descente ABR entre DEUX renditions connues : les (cc,sn) en
    // cache sont les octets de l'ANCIENNE rendition — incompatibles avec la
    // nouvelle (mêmes séquences, bytes différents). Purge + liens fermés par
    // le manager ; le prochain HEARTBEAT annoncera la fenêtre reconstruite.
    if (this.rid !== null && rid !== null) {
      this.cache.clear();
      void this.persist.clearSwarm(); // mêmes (cc,sn), octets incompatibles : rien ne survit en disque
    }
    this.rid = rid;
    this.peerManager.setRid(rid);
  }

  /** Capacité MUTABLE (off/low/normal) : le web la pilote (bascule Éco,
   *  arrière-plan, data-saver). Elle est RELUE par le coordinateur à chaque
   *  HEARTBEAT (règle serveur §18 : cap=off ne publie pas de fenêtre).
   *  (Initialisée dans le constructeur : this.opts est un paramètre
   *  propriété, pas un champ au sens ES2022.) */
  private capacity: 'off' | 'low' | 'normal';
  setCapacity(cap: 'off' | 'low' | 'normal'): void {
    if (this.capacity === cap) return;
    this.capacity = cap;
    this.opts.trace?.({ t: 'capacity', cap });
    if (cap === 'off') this.peerManager.pauseSeeding();
  }

  async start(): Promise<boolean> {
    if (this.started || this.disposed) return this.started;
    this.started = true;
    const pollBase = derivePollBase(this.opts.meshUrl);
    const signaling = new Signaling({
      meshUrl: this.opts.meshUrl, token: this.opts.token, pollBase,
      fetchImpl: this.opts.fetchImpl, wsFactory: this.opts.wsFactory as never, now: this.opts.now,
    });
    this.signaling = signaling;
    signaling.onMessage((raw) => this.onDownstream(raw));
    signaling.onStatus((status) => { if (status === 'dead') this.dispose(); });
    signaling.connect();
    this.up('JOIN_SWARM', { proto: MESH_PROTOCOL_VERSION, cap: this.capacity, net: this.opts.networkType, rid: this.rid });
    this.scheduleHeartbeat();
    return true;
  }

  private envelope(type: string, data: Record<string, unknown>): string {
    return JSON.stringify({ v: MESH_PROTOCOL_VERSION, t: type, sid: this.opts.swarmId, id: this.opts.selfPid, seq: ++this.seq, ts: this.opts.now?.() ?? Date.now(), d: data });
  }
  private up(type: string, data: Record<string, unknown>): void { this.signaling?.send(this.envelope(type, data)); }

  private onDownstream(raw: string): void {
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return; }
    const parsed = meshCoordinatorMessageSchema.safeParse(json);
    if (!parsed.success) return; // message inconnu : ignoré (extensibilité v1)
    const message = parsed.data;
    switch (message.t) {
      case 'JOIN_ACCEPTED':
        this.cfg = message.d.cfg;
        this.peerManager.reconfigure(this.cfg);
        // Kill switch serveur : PAUSE réversible (plus de liens, plus de
        // demandes, pas de fenêtre publiée) — la socket reste ouverte pour
        // recevoir le CONFIG de reprise. JAMAIS stop() ici : l'activation
        // progressive (§31 brief) joue sur ce bouton sans redéploiement.
        if (!this.cfg.p2pEnabled) { this.pause(); return; }
        if (this.paused) this.resume();
        this.applyPeers(message.d.peers);
        return;
      case 'PEER_CANDIDATES': if (!this.paused) this.applyPeers(message.d.peers); return;
      case 'CONFIG':
        this.cfg = message.d;
        this.peerManager.reconfigure(this.cfg);
        if (!message.d.p2pEnabled) this.pause();
        else if (this.paused) this.resume();
        return;
      case 'PEER_JOINED': if (!this.paused) this.applyPeers([message.d]); return;
      case 'PEER_REMOVE': for (const id of message.d.ids) this.peerManager.remove(id); return;
      case 'KICK': this.stop(); return;
      case 'DRAIN': this.peerManager.pauseSeeding(); return;
      case 'SIGNAL_OFFER': case 'SIGNAL_ANSWER': case 'ICE_CANDIDATE':
        if (this.paused) return; // plus de liens en pause : le signaling entrant est du bruit
        this.peerManager.onSignal(message.d.from, message.t, 'c' in message.d ? { c: message.d.c } : { sdp: message.d.sdp });
        return;
      case 'ERROR':
        if (message.d.code === 'INVALID_TOKEN' || message.d.code === 'TOKEN_EXPIRED' || message.d.code === 'PROTOCOL_UNSUPPORTED' || message.d.code === 'SWARM_FULL') this.stop();
        return;
      default: return;
    }
  }

  /** Kill-switch EN PAUSE (étape 5) : on ne demande plus rien aux pairs, on ne
   *  publie plus de fenêtre, les liens sont fermés PROGRESSIVEMENT (close
   *  propre des DataChannels en vol par PeerLink.close). La lecture continue :
   *  allowed() devient false → le loader est un passe-through origin. */
  private pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.opts.trace?.({ t: 'kill', enabled: false });
    this.peerManager.pauseSeeding();
  }

  /** Reprise après kill-switch : re-JOIN idempotent → JOIN_ACCEPTED frais avec
   *  les candidats actuels → liens reconstruits. Jamais agressif : cadencé par
   *  le CONFIG du serveur (un seul resume par transition). */
  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.opts.trace?.({ t: 'kill', enabled: true });
    this.up('JOIN_SWARM', { proto: MESH_PROTOCOL_VERSION, cap: this.capacity, net: this.opts.networkType, rid: this.rid });
  }

  private applyPeers(peers: MeshPeerSummary[]): void {
    this.peerManager.applyCandidates(peers); // la compatibilité rid est tranchée par PeerManager/HELLO
    this.metrics.peers(this.peerManager.peerCount);
  }

  private scheduleHeartbeat(): void {
    if (this.disposed) return;
    const interval = this.cfg?.heartbeatMs ?? 30_000;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.disposed || !this.signaling) return;
      // En pause, on bat toujours : la fenêtre publiée est NULL (règle serveur
      // §18 doublée client) et la socket reste vivante pour recevoir le CONFIG
      // de reprise. Sans ce battement, le TTL de 120 s éjecterait le pair et
      // la reprise ne pourrait plus le toucher.
      const win = this.paused ? null : this.cache.window(this.cfg?.windowSize ?? 20);
      this.up('HEARTBEAT', { cap: this.capacity, win, rid: this.rid });
      // Auto-cicatrisation de la découverte : le serveur ne notifie un
      // PEER_JOINED qu'aux abonnés existants — un pair arrivé tôt avec zéro
      // lien ne saurait jamais rien des nouveaux seeders. Le re-JOIN est
      // IDEMPOTENT côté serveur (même pid : UPDATE + liste fraîche) ; cadencé
      // par le heartbeat (30 s) il ne peut pas devenir une tempête.
      if (!this.paused && this.cfg?.p2pEnabled && this.peerManager.peerCount < Math.min(2, this.peerManager.maxPeers)) {
        this.up('JOIN_SWARM', { proto: MESH_PROTOCOL_VERSION, cap: this.capacity, net: this.opts.networkType, rid: this.rid });
      }
      // STATS_REPORT agrégées (§12 brief : jamais de détail par pair remonté) :
      // deltas depuis le dernier report, cadencés par statsIntervalMs.
      const statsEvery = this.cfg?.statsIntervalMs ?? 120_000;
      const now = this.opts.now?.() ?? Date.now();
      if (this.lastStatsAt === 0) this.lastStatsAt = now;
      if (now - this.lastStatsAt >= statsEvery) {
        const d = this.statsDelta;
        if (d.upBytes || d.peerDlBytes || d.peerOk || d.peerFail) {
          const fastest = this.peerManager.fastestRttMs();
          this.up('STATS_REPORT', { upBytes: d.upBytes, peerDlBytes: d.peerDlBytes, peerOk: d.peerOk, peerFail: d.peerFail, rttMs: fastest });
          this.statsDelta = { upBytes: 0, peerDlBytes: 0, peerOk: 0, peerFail: 0 };
        }
        this.lastStatsAt = now;
      }
      this.scheduleHeartbeat();
    }, interval);
  }

  /** Le loader demande un segment (cc, sn) : ≤ 2 pairs (sélection par score),
   *  jamais d'exception. En pause (kill-switch), échec immédiat 'dead'.
   *  Coalescence (§15) : un transfert déjà en vol pour ce (cc,sn) est
   *  PARTAGÉ, pas relancé — une seule requête logique = une seule métrique. */
  async requestSegment(cc: number, sn: number): Promise<{ ok: boolean; bytes?: Uint8Array; reason?: string }> {
    if (!this.cfg?.p2pEnabled || this.paused || !this.signaling) return { ok: false, reason: 'dead' };
    const key = `${cc}:${sn}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const flight = this.fetchFromPeers(cc, sn);
    this.inflight.set(key, flight);
    try {
      return await flight;
    } finally {
      if (this.inflight.get(key) === flight) this.inflight.delete(key);
    }
  }

  /** Préchargement P2P contrôlé (§16) : pari d'avance PEER-ONLY, fire-and-
   *  forget. Ne va JAMAIS en origin, ne bloque jamais, ne pollue ni le
   *  backoff ni la télémétrie de repli (un pari d'avance perdu n'est pas un
   *  échec de lecture). Le succès remplit mémoire+IDB pour le vrai load qui
   *  suit — et si le loader demande pendant le vol, il REJOINT ce transfert
   *  (coalescence) au lieu d'en lancer un second. Appelé par le loader quand
   *  le buffer est CONFORTABLE (garde côté session), jamais en zone critique. */
  prefetchSegment(cc: number, sn: number): void {
    if (this.disposed || this.paused || !this.cfg?.p2pEnabled || !this.signaling) return;
    if (!this.trusted()) return; // pas de pari sans pairs fiables — surtout pas en tâche de fond
    const key = `${cc}:${sn}`;
    if (this.inflight.has(key)) return; // le loader (ou un prefetch) s'en occupe déjà
    if (this.cache.get(cc, sn)) return; // déjà en mémoire : rien à préparer
    const rid = this.rid;
    const flight = (async (): Promise<{ ok: boolean; bytes?: Uint8Array; reason?: string }> => {
      let result: { ok: boolean; bytes?: Uint8Array; reason?: string };
      try {
        result = await this.peerManager.requestSegment(cc, sn);
      } catch {
        result = { ok: false, reason: 'dead' };
      }
      // Succès : seed mémoire (déjà fait par PeerLink) + persistant. Le score
      // pair est déjà à jour via le manager. Échec : silence total — c'était
      // un pari gratuit, pas une demande du lecteur.
      if (result.ok && result.bytes && this.rid === rid && !this.disposed) {
        void this.persist.put(cc, sn, result.bytes, 'peer', this.rid);
      }
      return result;
    })();
    this.inflight.set(key, flight);
    void flight.catch(() => undefined).finally(() => {
      if (this.inflight.get(key) === flight) this.inflight.delete(key);
    });
  }

  /** Le transfert pair réel (≤ 2 pairs séquentiels, §24 brief étape 5).
   *  Exécuté UNE fois par (cc,sn) en vol — voir requestSegment. */
  private async fetchFromPeers(cc: number, sn: number): Promise<{ ok: boolean; bytes?: Uint8Array; reason?: string }> {
    const rid = this.rid;
    this.metrics.attempt(); // UNE requête logique = UNE tentative comptée (coalescence §15)
    const t0 = this.opts.now?.() ?? Date.now();
    let result: { ok: boolean; bytes?: Uint8Array; reason?: string };
    try {
      result = await this.peerManager.requestSegment(cc, sn);
    } catch {
      result = { ok: false, reason: 'dead' }; // règle n°1 : le loader doit pouvoir retomber origin, quoi qu'il arrive ici
    }
    if (result.ok && result.bytes) {
      // Rendition changée en vol (ABR) : les octets reçus appartiennent à
      // l'ANCIENNE rendition — jetés SANS bruit (ni cache, ni métrique de
      // succès) ; le loader retombera origin sur la bonne rendition.
      if (this.rid !== rid || this.disposed) return { ok: false, reason: 'dead' };
      this.consecutivePeerFails = 0; this.backoffUntil = 0; // un succès rétablit la confiance immédiatement
      this.metrics.success(result.bytes.length);
      this.metrics.bytesReceived(result.bytes.length);
      this.statsDelta.peerOk += 1;
      this.statsDelta.peerDlBytes += result.bytes.length;
      // PeerLink a déjà mis en mémoire (il sert sa propre fenêtre) : ici on
      // persiste. C'est LE point unique d'écriture disque des segments pairs.
      void this.persist.put(cc, sn, result.bytes, 'peer', this.rid);
    } else {
      this.statsDelta.peerFail += 1;
      this.metrics.peerFailure?.(result.reason ?? 'timeout');
      // Repli origin corrélé (canary) : le loader émettra tier:'origin' ; ce
      // 'fallback' porte la RAISON et la durée du pari perdu (jointure par cc/sn).
      try {
        this.opts.trace?.({ t: 'fallback', cc, sn, reason: String(result.reason ?? 'timeout').slice(0, 32), ms: Math.max(0, Math.round((this.opts.now?.() ?? Date.now()) - t0)) });
      } catch { /* instrumentation jamais bloquante */ }
      // Seuls les échecs qui traduisent une indisponibilité du mesh comptent
      // pour le backoff : un pair 'unavailable' (n'a plus ce segment) est un
      // échec LOCAL de pari, pas une panne — ne pas couper tout le mesh pour ça.
      if (result.reason === 'timeout' || result.reason === 'dead' || result.reason === 'hash') {
        this.consecutivePeerFails += 1;
        const cfg = this.scoreConfig();
        if (this.consecutivePeerFails >= cfg.backoffAfter) this.backoffUntil = (this.opts.now?.() ?? Date.now()) + cfg.backoffMs;
      }
      if (result.reason === 'hash') this.metrics.hashFail();
      else this.metrics.timeout();
      // FALLBACK_PING throttlé (1 par 15 s) : le serveur compte « combien de
      // fois le P2P a échoué », jamais quel pair — télémétrie pure (§46 ADR).
      this.notifyFallback(cc, sn, result.reason === 'timeout' ? 'PEER_TIMEOUT' : result.reason === 'hash' ? 'CORRUPT_SEGMENT' : 'PEER_FAILED');
    }
    return result;
  }

  /** Config de scoring courante (override serveur éventuel, sinon défauts
   *  contrats). Une seule source de vérité des seuils : jamais de nombre en dur. */
  private scoreConfig() {
    return { ...MESH_SCORE_DEFAULTS, ...this.cfg?.score };
  }

  /** Le loader peut-il PARIER sur un pair maintenant ? (§25) : enabled ET hors
   *  backoff ET meilleur score pair ≥ trustThreshold. Un false = origin direct,
   *  sans même interroger les pairs (démarrage fiable > économie de bande). */
  trusted(): boolean {
    if (!this.enabled) return false;
    const now = this.opts.now?.() ?? Date.now();
    if (now < this.backoffUntil) return false;
    return this.peerManager.bestScore() >= this.scoreConfig().trustThreshold;
  }

  /** Un FALLBACK_PING au plus toutes les 15 s (le loader, lui, retombe origin
   *  à chaque fois — seule la MESURE est throttlée). */
  private notifyFallback(_cc: number, sn: number, reason: 'PEER_TIMEOUT' | 'PEER_FAILED' | 'CORRUPT_SEGMENT' | 'NO_PEERS'): void {
    const now = this.opts.now?.() ?? Date.now();
    if (now - this.lastFallbackPingAt < 15_000) return;
    this.lastFallbackPingAt = now;
    this.up('FALLBACK_PING', { sn, reason });
  }

  /** Origin → seed : le loader appelle ça à chaque segment passé par origin.
   *  Mémoire + persistants sont écrits ICI (l'unique point d'entrée origin).
   *  Un pair cap=off remplit AUSSI son cache (relecture locale au retry du
   *  Player, et il passera peut-être à low/normal) ; « ne pas seeder » est
   *  porté par l'absence d'annonce de fenêtre (HEARTBEAT) + la règle serveur. */
  seedOrigin(cc: number, sn: number, bytes: Uint8Array): void {
    if (!this.cfg?.p2pEnabled || this.paused) return;
    void this.cache.put(cc, sn, bytes, 'origin');
    void this.persist.put(cc, sn, bytes, 'origin', this.rid);
    this.metrics.bytesFromOrigin?.(bytes.length);
  }

  /** Tier persistant exposé au loader (hiérarchie mémoire→IDB→pairs). Le
   *  PersistentCache ne rejette JAMAIS : erreur/quota/absence = miss pur. La
   *  MÉTRIQUE des octets IDB est comptée par le loader (idbHit), pas ici. */
  async cacheGetPersistent(cc: number, sn: number): Promise<Uint8Array | null> {
    const entry = await this.persist.get(cc, sn);
    return entry?.data ?? null;
  }

  /** Hit IDB → remontée mémoire SANS ré-écrire sur disque. */
  promoteMemory(cc: number, sn: number, bytes: Uint8Array): void {
    void this.cache.put(cc, sn, bytes, 'cache'); // promotion depuis le tier persistant — pas une origine réseau
  }

  get enabled(): boolean { return Boolean(this.cfg?.p2pEnabled && !this.paused && !this.disposed); }
  get config(): MeshConfig | null { return this.cfg; }

  /** République immédiatement la fenêtre au coordinateur (retour
   *  d'arrière-plan, changement de capacité) SANS attendre le prochain
   *  battement de 30 s. Idempotent et borné : rien si pas de signaling ou en
   *  pause. Le pair redevient seeder aussitôt que le consentement le permet. */
  republish(): void {
    if (this.disposed || this.paused || !this.signaling || !this.cfg?.p2pEnabled) return;
    const win = this.cache.window(this.cfg?.windowSize ?? 20);
    this.up('HEARTBEAT', { cap: this.capacity, win, rid: this.rid });
  }

  stop(): void { void this.dispose(); }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.up('LEAVE_SWARM', { reason: 'user' });
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.peerManager.close();
    this.signaling?.close();
    this.signaling = null;
    // Politique de rétention d'un système LIVE (§6 brief) : quitter un swarm
    // purge SES données persistantes. Rien ne survit à une session finie.
    void this.persist.clearSwarm();
  }
}

