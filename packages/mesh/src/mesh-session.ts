// Session MeshStream pour le web (étape 4 POC) : assemble client + loader +
// métriques derrière UNE poignée, et fournit le point d'accroche du Player.
//
// Règle n°1 (jamais bloquer la vidéo) :
//   - `bind(hls)` écrit hls.config.fLoader — hls.js relit config.fLoader À
//     CHAQUE fragment (vérifié dans la source 1.6.17, loadFragment) :
//     l'injection est à chaud et annulable (le débranchement est retourné).
//   - Tant que le client n'est pas JOIN-accepté ET qu'il n'a pas ≥ 1 pair
//     usable, allowed() est false → le BoundLoader est un PASSTHROUGH vers
//     le loader origin natif : chemin actuel, ligne à ligne.
//   - dispose()/unbind → démontage complet ; le lecteur n'a rien vu passer.
//
// Le package mesh n'importe PAS hls.js en runtime (types only) : c'est le
// Player qui fournit l'instance et le constructeur du loader natif.
import type Hls from 'hls.js';
import type { Loader, LoaderContext, FragmentLoaderContext, HlsConfig } from 'hls.js';
import { MeshClient, NOOP_METRICS, type MeshMetrics } from './mesh-client';
import { MeshLoader, type LoaderDeps } from './mesh-loader';
import { detectMeshCapabilities, type MeshCapabilities } from './capabilities';
import type { RtcEnv } from './peer-link';
import type { SegmentStore } from './persistent-cache';
import type { MeshTrace } from './trace';
import { readMeshTokenClaims } from '@mbolo/contracts';

/** Attributs d'une rendition (hls.js Level.attrs — membres lus : RESOLUTION,
 *  BANDWIDTH, CODECS). */
export interface RenditionAttrs { RESOLUTION?: string; BANDWIDTH?: string; CODECS?: string }

/** Constructeur du loader natif hls.js (Hls.DefaultConfig.loader — typé
 *  Loader<LoaderContext> par hls.js lui-même ; hls.js l'utilise comme loader
 *  de fragment via un cast interne — on reproduit cette convention). */
export type OriginLoaderCtor = new (config: HlsConfig) => Loader<LoaderContext>;

export interface MeshSessionOptions {
  token: string;                    // meshToken (PlayResponse)
  meshUrl: string;                  // wss://…/mesh/ws
  capacity: 'off' | 'low' | 'normal';
  networkType: 'wifi' | 'cellular' | 'wired' | 'unknown';
  iceServers: RTCIceServer[];       // STUN configurables par env (JAMAIS hardcodé ; JAMAIS de TURN à cette étape — §7)
  env?: RtcEnv;                     // injection pour tests
  fetchImpl?: typeof fetch;
  wsFactory?: (url: string) => WebSocket;
  now?: () => number;
  metrics?: MeshMetrics;
  /** Store du cache persistant (InMemoryStore en test ; IndexedDB par défaut
   *  en navigateur ; null = persistant désactivé, le mémoire suffit). */
  persistentStore?: SegmentStore | null;
  /** Nature du contenu (le Player la connaît ; le mesh ne la devine jamais).
   *  Défaut 'live'. GlobalPlayer ne monte le mesh QUE pour le live — le VOD
   *  n'arrive jamais ici ; ce champ fige le contexte pour un futur réglage
   *  (ex. IDB plus utile en VOD stable) SANS changer le comportement v1. */
  contentKind?: 'live' | 'vod';
  /** Instrumentation [mesh-test] (§8) — branchée par poc.ts uniquement quand
   *  le POC est monté. Absente = zéro log, zéro coût. */
  trace?: MeshTrace;
}

/** Télémétrie MeshStream (§28 brief étape 5). Des COMPTEURS, jamais des
 *  contenus : pas d'IP, de token, d'URL fournisseur, de deviceId. Le ratio
 *  d'offload se lit via peerHitRate()/meshOffload() — jamais en exposant un
 *  détail par pair. */
export interface MeshStats {
  meshAttempts: number;        // segments pour lesquels un pari P2P a été tenté
  memoryHits: number;          // servis par le cache mémoire (aucun réseau)
  persistentCacheHits: number; // servis par IndexedDB (aucun réseau, promotion mémoire)
  peerHits: number;            // servis par un pair
  originHits: number;          // rendu par origin après tentative mesh perdue
  /** Téléchargements origin ÉVITÉS (bande passante, §20-21) : +1 par segment
   *  logique servi SANS origin (mémoire, IDB ou pair). Exactement un par
   *  segment : le loader s'arrête au premier hit, donc mémoire→IDB ne compte
   *  jamais double. Une ESTIMATION prudente (un hit local aurait nécessité un
   *  fetch origin), jamais une mesure réseau absolue. */
  originRequestsAvoided: number;
  peerFailures: number;        // tentatives pair non soldées (toutes raisons)
  peerTimeouts: number;
  peerHashFailures: number;
  webrtcSuccess: number;
  webrtcFailure: number;
  bytesFromPeers: number;
  bytesFromOrigin: number;
  bytesFromMemory: number;
  bytesFromIndexedDB: number;
  bytesServedToPeers: number;
  peers: number;               // gauge : liens usables actuellement
}

export function emptyMeshStats(): MeshStats {
  return {
    meshAttempts: 0, memoryHits: 0, persistentCacheHits: 0, peerHits: 0, originHits: 0,
    originRequestsAvoided: 0,
    peerFailures: 0, peerTimeouts: 0, peerHashFailures: 0, webrtcSuccess: 0, webrtcFailure: 0,
    bytesFromPeers: 0, bytesFromOrigin: 0, bytesFromMemory: 0, bytesFromIndexedDB: 0, bytesServedToPeers: 0, peers: 0,
  };
}

/** Taux de succès du pari P2P parmi les segments qui lui ont été demandés.
 *  Jamais de division par zéro : 0 si aucune tentative (honnête : « pas de
 *  données », pas « 100 % »). */
export function peerHitRate(stats: MeshStats): number {
  const settled = stats.peerHits + stats.originHits;
  return settled === 0 ? 0 : stats.peerHits / settled;
}

/** Part des octets fournis par les pairs (vs origin) — la mesure RÉELLE du
 *  gain, celle que l'ADR veut voir, avec le même anti-division-par-zéro. */
export function meshOffload(stats: MeshStats): number {
  const bytes = stats.bytesFromPeers + stats.bytesFromOrigin;
  return bytes === 0 ? 0 : stats.bytesFromPeers / bytes;
}

export class MeshSession {
  readonly capabilities: MeshCapabilities;
  readonly stats: MeshStats = emptyMeshStats();
  private client: MeshClient | null = null;
  private originCtor: OriginLoaderCtor | null = null;
  private boundAt = 0;
  private boundHls: Hls | null = null;
  private startPromise: Promise<boolean> | null = null;
  private disposed = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pid: string;
  private readonly sid: string;

  constructor(private readonly opts: MeshSessionOptions) {
    this.capabilities = detectMeshCapabilities();
    const claims = readMeshTokenClaims(opts.token); // claims lus SANS vérifier (le mesh worker vérifie la signature ; ce sont des identifiants émis serveur)
    if (!claims) throw new Error('meshToken illisible');
    this.pid = claims.pid;
    this.sid = claims.sid;
  }

  /** Constructeur à passer en `fLoader` : instancié PAR hls.js à chaque
   *  fragment. Si le mesh n'est pas prêt : passe-through total vers l'origin. */
  readonly fLoader = (() => {
    const session = this;
    class BoundLoader implements Loader<FragmentLoaderContext> {
      context: FragmentLoaderContext | null = null;
      stats: Loader<FragmentLoaderContext>['stats'];
      private inner: Loader<FragmentLoaderContext>;
      constructor(config: HlsConfig) {
        const deps = session.deps();
        this.inner = deps ? new MeshLoader(deps, config) : session.newOrigin(config);
        this.stats = this.inner.stats;
      }
      load(ctx: FragmentLoaderContext, cfg: Parameters<Loader<FragmentLoaderContext>['load']>[1], cb: Parameters<Loader<FragmentLoaderContext>['load']>[2]) { this.context = ctx; this.stats = this.inner.stats; this.inner.load(ctx, cfg, cb); }
      abort() { this.inner.abort(); }
      destroy() { this.inner.destroy(); }
      getCacheAge() { return this.inner.getCacheAge?.() ?? null; }
      getResponseHeader(name: string) { return this.inner.getResponseHeader?.(name) ?? null; }
    }
    return BoundLoader;
  })();

  /** Fabrique le loader ORIGIN natif du Player. Jamais appelé sans bind()
   *  préalable : le BoundLoader n'est instancié par hls.js qu'UNE FOIS
   *  config.fLoader branché, donc après bind. */
  private newOrigin(config: HlsConfig): Loader<FragmentLoaderContext> {
    if (!this.originCtor) throw new Error('MeshSession.bind() doit précéder l usage du loader');
    // Cast identique à celui de hls.js (DefaultILoader instancié pour un
    // contexte de fragment — Loader<LoaderContext> → Loader<FragmentLoaderContext>).
    return new this.originCtor(config) as unknown as Loader<FragmentLoaderContext>;
  }

  /** Branchement sur l'instance Hls du Player. Retourne le DÉBRANCHEMENT
   *  (à appeler au destroy du Player). */
  bind(hls: Hls, OriginCtor: OriginLoaderCtor): () => void {
    this.originCtor = OriginCtor;
    this.boundAt = this.opts.now?.() ?? Date.now();
    const prev = hls.config.fLoader;
    hls.config.fLoader = this.fLoader as unknown as Hls['config']['fLoader']; // relue à chaque fragment (hls.js 1.6.17)
    this.boundHls = hls;
    this.start(); // le JOIN démarre dès qu'il y a un lecteur branché
    // Télémétrie : compteurs + ids éphémères tronqués + ratios d'offload —
    // JAMAIS token, IP, deviceId, URL fournisseur (§29/§47 du brief).
    this.statsTimer = setInterval(() => {
      if (!this.disposed && this.client?.enabled) {
        console.info('[mesh]', this.sid.slice(0, 8), JSON.stringify({ ...this.stats, peerHitRate: Math.round(this.peerHitRate() * 100) / 100, offload: Math.round(this.meshOffload() * 100) / 100 }));
      }
    }, 30_000);
    return () => {
      if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
      if (this.boundHls && this.boundHls.config.fLoader === this.fLoader) this.boundHls.config.fLoader = prev;
      this.boundHls = null;
    };
  }

  /** Rendition active : le Player l'appelle aux événements MANIFEST_PARSED /
   *  LEVEL_SWITCHED (là où hls.js expose level.attrs). rid = sha256(cana)[:8]
   *  (WebCrypto native navigateur — spec §6.1 ; la frontière SÉCURISÉE reste
   *  le swarmId HMAC serveur). */
  levelChanged(attrs: RenditionAttrs | null | undefined): void {
    if (!attrs?.RESOLUTION || this.disposed) return;
    void computeMeshRid(attrs).then((rid) => { if (!this.disposed) this.client?.setRid(rid); });
  }

  /** Capacité de SEEDING du pair (off/low/normal) : pilotée par le web —
   *  jamais par le serveur. La relue par le coordinateur à chaque HEARTBEAT. */
  setCapacity(cap: 'off' | 'low' | 'normal'): void { this.client?.setCapacity(cap); }

  /** République la fenêtre maintenant (retour d'arrière-plan). Le web l'appelle
   *  après un setCapacity de reprise pour ne pas attendre le battement de 30 s. */
  republish(): void { this.client?.republish(); }

  /** Démarre le JOIN (idempotent ; appelé par bind). Faux = pas de mesh. */
  start(): Promise<boolean> {
    if (this.startPromise) return this.startPromise;
    if (!this.capabilities.compatible || this.disposed) { this.startPromise = Promise.resolve(false); return this.startPromise; }
    this.client = new MeshClient({
      token: this.opts.token, meshUrl: this.opts.meshUrl, levelUrl: '', selfPid: this.pid, swarmId: this.sid,
      capacity: this.opts.capacity, networkType: this.opts.networkType,
      env: this.opts.env ?? {
        RTCPeerConnection: (globalThis as unknown as { RTCPeerConnection: typeof globalThis.RTCPeerConnection }).RTCPeerConnection,
        RTCIceCandidate: (globalThis as unknown as { RTCIceCandidate: typeof globalThis.RTCIceCandidate }).RTCIceCandidate,
        iceServers: this.opts.iceServers,
      },
      fetchImpl: this.opts.fetchImpl, wsFactory: this.opts.wsFactory, now: this.opts.now,
      persistentStore: this.opts.persistentStore === null ? undefined : this.opts.persistentStore,
      trace: this.opts.trace,
      metrics: {
        ...NOOP_METRICS, ...this.opts.metrics,
        attempt: () => { this.stats.meshAttempts += 1; this.opts.metrics?.attempt(); },
        success: (n) => { this.stats.peerHits += 1; this.stats.originRequestsAvoided += 1; this.stats.bytesFromPeers += n; this.opts.metrics?.success(n); },
        timeout: () => { this.stats.peerTimeouts += 1; this.opts.metrics?.timeout(); },
        hashFail: () => { this.stats.peerHashFailures += 1; this.opts.metrics?.hashFail(); },
        peerFailure: (reason) => { this.stats.peerFailures += 1; this.opts.metrics?.peerFailure?.(reason); },
        bytesServed: (n) => { this.stats.bytesServedToPeers += n; this.opts.metrics?.bytesServed(n); },
        bytesFromOrigin: (n) => { this.stats.bytesFromOrigin += n; this.opts.metrics?.bytesFromOrigin?.(n); },
        bytesFromMemory: (n) => { this.stats.bytesFromMemory += n; this.opts.metrics?.bytesFromMemory?.(n); },
        bytesFromIndexedDB: (n) => { this.stats.bytesFromIndexedDB += n; this.opts.metrics?.bytesFromIndexedDB?.(n); },
        webrtcOk: () => { this.stats.webrtcSuccess += 1; this.opts.metrics?.webrtcOk(); },
        webrtcFail: () => { this.stats.webrtcFailure += 1; this.opts.metrics?.webrtcFail(); },
        peers: (n) => { this.stats.peers = n; this.opts.metrics?.peers(n); },
      },
    });
    this.startPromise = this.client.start();
    return this.startPromise;
  }

  /** Les guards du loader, réévalués À CHAQUE segment (le mesh peut apparaître
   *  ou disparaître à chaud entre deux fragments). deps() est NON-NULL dès que
   *  le client est ENABLE (kill-switch OFF, jeton vivant, liens possibles) :
   *  le cache mémoire/persistant, lui, sert TOUJOURS (gratuit, local). Le pari
   *  pair est ensuite gate par allowed()=trusted() (pairs + score + pas de
   *  backoff) + started + bufferOk + liveEdgeOk. client.enabled false (mesh
   *  inconnu/mort) → null → le BoundLoader est un PASSTHROUGH origin intégral. */
  deps(): LoaderDeps | null {
    const client = this.client;
    if (this.disposed || !this.boundHls || !client || !client.enabled) return null;
    const hls = this.boundHls;
    const now = (): number => this.opts.now?.() ?? Date.now();
    const metrics = this.opts.metrics;
    return {
      makeOrigin: (config) => this.newOrigin(config),
      allowed: () => client.trusted(), // pairs présents ET score ≥ trust ET hors backoff
      started: () => now() - this.boundAt > 5_000, // grâce structurelle de démarrage (§19)
      bufferOk: () => (hls.mainForwardBufferInfo?.len ?? 0) >= (client.config?.bufferCriticalSec ?? 12),
      liveEdgeOk: (_cc, sn) => {
        const details = hls.latestLevelDetails;
        if (!details) return false;
        return sn <= details.endSN - (client.config?.liveEdgeSafetySegments ?? 2); // les N derniers du direct : origin, toujours
      },
      cacheGet: (cc, sn) => client.cache.get(cc, sn)?.bytes ?? null,
      cacheGetPersistent: (cc, sn) => client.cacheGetPersistent(cc, sn),
      promoteMemory: (cc, sn, bytes) => client.promoteMemory(cc, sn, bytes),
      cacheSeed: (cc, sn, bytes) => void client.seedOrigin(cc, sn, bytes),
      requestSegment: (cc, sn) => client.requestSegment(cc, sn),
      // Pari d'avance §16 — UNIQUEMENT si le buffer est CONFORTABLE (≥ 2× le
      // seuil critique : jamais en zone tendue), hors live edge dangereux, et
      // client digne de confiance. Le prefetch lui-même re-vérifie trusted()
      // et reste peer-only : ici on ne fait que refuser tôt les cas évidents.
      prefetch: (cc, sn) => {
        if (this.disposed || !client.enabled || !client.trusted()) return;
        const critical = client.config?.bufferCriticalSec ?? 12;
        if ((hls.mainForwardBufferInfo?.len ?? 0) < 2 * critical) return;
        const details = hls.latestLevelDetails;
        if (details && sn > details.endSN - (client.config?.liveEdgeSafetySegments ?? 2)) return;
        client.prefetchSegment(cc, sn);
      },
      trace: this.opts.trace,
      metrics: {
        cacheHit: (bytes) => { this.stats.memoryHits += 1; this.stats.originRequestsAvoided += 1; this.stats.bytesFromMemory += bytes; },
        idbHit: (bytes) => { this.stats.persistentCacheHits += 1; this.stats.originRequestsAvoided += 1; this.stats.bytesFromIndexedDB += bytes; },
        origin: () => { this.stats.originHits += 1; metrics?.fallbackOrigin(); },
      },
    };
  }

  get enabled(): boolean { return Boolean(this.client?.enabled); }

  /** Nature du contenu vu par cette session ('live' par défaut — le seul
   *  contexte monté aujourd'hui ; VOD préparé, comportement identique). */
  get contentKind(): 'live' | 'vod' { return this.opts.contentKind ?? 'live'; }

  /** swarmId tronqué (8 hex) pour l'[mesh-test] — jamais l'identité complète,
   *  jamais sourceId/channelId (le swarmId est lui-même un HMAC opaque). */
  get swarmLabel(): string { return this.sid.slice(0, 8); }

  /** peerId ÉPHÉMÈRE (22 base64url, jamais lié au compte) — exposé pour la
   *  corrélation locale des dumps de test (le même pid figure dans les
   *  événements trace de CET appareil uniquement). */
  get peerLabel(): string { return this.pid; }

  /** Calculs de télémétrie (§28) — à l'abri des divisions par zéro. */
  peerHitRate(): number { return peerHitRate(this.stats); }
  meshOffload(): number { return meshOffload(this.stats); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.boundHls && this.boundHls.config.fLoader === this.fLoader) this.boundHls.config.fLoader = undefined;
    this.client?.stop();
    this.client = null;
  }
}

/** sha256(cana("RESOLUTION,BANDWIDTH,CODECS"))[:8] — désambiguïse les
 *  renditions entre clients du MÊME swarm (le swarmId HMAC serveur reste la
 *  frontière autorisée ; rid est un filtre d'échange, pas une preuve). */
export async function computeMeshRid(attrs: RenditionAttrs): Promise<string | null> {
  if (!attrs?.RESOLUTION) return null;
  const canonical = `${attrs.RESOLUTION},${attrs.BANDWIDTH ?? ''},${attrs.CODECS ?? ''}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
}

export function createMeshSession(opts: MeshSessionOptions): MeshSession | null {
  try {
    return new MeshSession(opts);
  } catch {
    return null;
  }
}
