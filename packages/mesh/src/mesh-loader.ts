// MeshLoader — loader hls.js (`fLoader` — vérifié dans les typings hls.js
// 1.6.17 : `fLoader?: FragmentLoaderConstructor`, instancié `new fLoader(config)`
// POUR CHAQUE fragment (FragmentLoader.loadFragment), callbacks onSuccess
// (response, stats, context, networkDetails)).
//
// Conséquence de l'instanciation par fragment : TOUT l'état de décision est
// dans le `deps` partagé (créé par le web bridge) — le loader lui-même est
// sans mémoire, donc rien ne survit à tort entre deux loads.
//
// Chemin par segment (règle n°1 : le P2P ne bloque JAMAIS le lecteur).
// Hiérarchie étape 5 (§7 du brief) SOUS les gardes structurelles de l'étape 4 :
//   1. guards (deps.allowed / started / bufferOk / liveEdgeOk, + non-chiffré,
//      pas un init-segment, pas byte-range/part) → sinon ORIGIN direct ;
//   2. cache MÉMOIRE → succès immédiat (jamais on attend IDB si mémoire a) ;
//   3. cache PERSISTANT (IndexedDB, lecture bornée) → hit → promote mémoire +
//      succès ; IDB en échec = simplement un miss (le persistant est optionnel) ;
//   4. ≤ 2 pairs (deps.requestSegment — sélection par score, timeout pair) ;
//   5. sinon ORIGIN, puis seed (§20 du brief : A reçoit → A mémoire + A IDB →
//      A annonce → B demande à A).
//
// Identité du segment : (cc, sn) du Fragment hls.js — JAMAIS l'URL (le proxy
// la réécrit et la re-signe). spec §6.

import type { Loader, LoaderCallbacks, LoaderConfiguration, LoaderStats, FragmentLoaderContext, HlsConfig } from 'hls.js';
import type { MeshTraceEvent } from './trace';

/** Champs du Fragment lus par le loader (hls.js Fragment : sn:number|'initSegment', cc:number, encrypted, decryptdata). */
export interface FragLite { sn: number | 'initSegment'; cc: number; encrypted?: boolean; decryptdata?: unknown }
/** Le contexte de load hls.js vu par le loader (frag, part, et range éventuel). */
export interface LoadCtxLite { frag?: FragLite; part?: unknown; rangeStart?: number; rangeEnd?: number; url: string }

export interface LoaderDeps {
  /** Fabrique le loader ORIGIN natif (le web passe `new (Hls.DefaultConfig.loader)(config)`). */
  makeOrigin(config: HlsConfig): Loader<FragmentLoaderContext>;
  /** On peut PARIER sur un pair maintenant (mesh actif, pairs présents, score
   *  au-dessus du seuil de confiance, pas en backoff). Gate UNIQUEMENT la
   *  branche pair — les caches mémoire/persistant, eux, sont toujours tentés
   *  quand deps() existe (gratuits et locaux, §7/§26 brief). */
  allowed(): boolean;
  /** Lecture démarrée (≥ quelques segments bufferisés) : sinon origin (§19). */
  started(): boolean;
  /** Buffer devant la position ≥ bufferCriticalSec (sinon origin, §18). */
  bufferOk(): boolean;
  /** Le segment n'est pas dans la zone live edge (sinon origin, §18). */
  liveEdgeOk(cc: number, sn: number): boolean;
  cacheGet(cc: number, sn: number): Uint8Array | null;
  cacheSeed(cc: number, sn: number, bytes: Uint8Array): void;
  /** Tier persistant (IndexedDB) — OPTIONNEL : absent, le loader saute
   *  l'étape 3 et passe directement aux pairs (chemin mémoire+pair+origin).
   *  Résout TOUJOURS (undefined = miss) : ne rejette jamais, ne bloque jamais
   *  au-delà du budget interne au cache persistant. */
  cacheGetPersistent?(cc: number, sn: number): Promise<Uint8Array | null>;
  /** Promotion mémoire après un hit persistant (le loader l'appelle pour que
   *  le prochain accès soit un hit mémoire, §26 brief). Optionnel. */
  promoteMemory?(cc: number, sn: number, bytes: Uint8Array): void;
  /** ≤ 2 pairs tentés en interne (PeerManager). Résout toujours ; jamais de rejet. */
  requestSegment(cc: number, sn: number): Promise<{ ok: boolean; bytes?: Uint8Array; reason?: string }>;
  /** Le LOADER ne compte que ce que le client mesh ignore (succès/échecs pair
   *  sont comptés par le client lui-même) : hits de cache et retours origin. */
  metrics: { cacheHit(bytes: number): void; origin(): void; idbHit(bytes: number): void };
  /** Instrumentation [mesh-test] : un événement 'tier' par segment servi, avec
   *  la durée de récupération du tier (mesure §11 moyenne peer vs origin). */
  trace?(event: MeshTraceEvent): void;
}

function freshStats(): LoaderStats {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
    loading: { start: now, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: now, first: 0, end: 0 },
  };
}

export class MeshLoader implements Loader<FragmentLoaderContext> {
  context: FragmentLoaderContext | null = null;
  stats: LoaderStats = freshStats();
  private origin: Loader<FragmentLoaderContext> | null = null;
  private settled = false;
  private gen = 0; // à chaque load() une nouvelle génération invalide les réponses mesh en vol

  constructor(private readonly deps: LoaderDeps, private readonly config: HlsConfig) {}

  load(context: FragmentLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<FragmentLoaderContext>): void {
    this.context = context;
    this.settled = false;
    const gen = ++this.gen;
    this.stats = freshStats();
    const frag = context.frag as FragLite | undefined;
    // LL-HLS parts et requêtes byte-range portent sur des SOUS-ensembles du
    // segment : le cache est granularité segment entier — ces loads vont
    // DIRECTEMENT en origin (garde structurelle, jamais de confusion).
    const partialish = Boolean(context.part) || Boolean(context.rangeStart) || Boolean(context.rangeEnd);
    const cacheable = frag && !partialish && typeof frag.sn === 'number' && !frag.encrypted && !frag.decryptdata;
    if (cacheable) {
      void this.tryHierarchy(frag as { sn: number; cc: number }, context, config, callbacks, gen);
      return;
    }
    this.fetchOrigin(context, config, callbacks, gen);
  }

  // Hiérarchie §7 (sous les gardes §8) : mémoire → IndexedDB → pair(s) → origin.
  // Les deux premiers tiers sont LOCAUX et gratuits : tentés dès que le loader
  // mesh existe, indépendamment de allowed(). Seule la branche PAIR obéit aux
  // gardes (démarrage, buffer, live edge, confiance dans le meilleur pair).
  private async tryHierarchy(frag: { sn: number; cc: number }, context: FragmentLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<FragmentLoaderContext>, gen: number): Promise<void> {
    const trace = this.deps.trace; const t0 = this.nowMs();
    const tier = (name: 'memory' | 'idb' | 'peer' | 'origin'): void => trace?.({ t: 'tier', cc: frag.cc, sn: frag.sn, tier: name, ms: Math.round(this.nowMs() - t0) });
    // TIER 1 — mémoire : hit → service immédiat (on ne touche JAMAIS IDB si
    // la mémoire a déjà l'octet, §26).
    const mem = this.deps.cacheGet(frag.cc, frag.sn);
    if (mem) { tier('memory'); this.deps.metrics.cacheHit(mem.length); this.deliver(mem, context, callbacks, gen); return; }
    if (gen !== this.gen || this.settled) return;
    // TIER 2 — persistant (IndexedDB) : miss mémoire → lecture bornée. Absent
    // ou en erreur (le cache se désactive lui-même) → null = miss pur, on suit.
    if (this.deps.cacheGetPersistent) {
      let fromIdb: Uint8Array | null = null;
      try { fromIdb = await this.deps.cacheGetPersistent(frag.cc, frag.sn); } catch { fromIdb = null; }
      if (gen !== this.gen || this.settled) return; // seek/abort pendant la lecture IDB
      if (fromIdb) {
        tier('idb');
        this.deps.promoteMemory?.(frag.cc, frag.sn, fromIdb); // §26 : remonté en mémoire
        this.deps.metrics.idbHit(fromIdb.length);
        this.deliver(fromIdb, context, callbacks, gen);
        return;
      }
    }
    // TIER 3 — pairs : UNIQUEMENT si toutes les gardes structurelles passent.
    if (this.deps.allowed() && this.deps.started() && this.deps.bufferOk() && this.deps.liveEdgeOk(frag.cc, frag.sn)) {
      const result = await this.deps.requestSegment(frag.cc, frag.sn);
      if (gen !== this.gen || this.settled) return; // une nouvelle génération (abort/seek) a pris le relais
      if (result.ok && result.bytes) {
        tier('peer');
        this.deps.cacheSeed(frag.cc, frag.sn, result.bytes); // reçu d'un pair : je le tiens à mon tour
        this.deliver(result.bytes, context, callbacks, gen);
        return;
      }
    }
    // TIER 4 — ORIGIN. Ce segment a traversé la hierarchie sans hit → counted
    // comme un repli origin (mesh tenté ou non, c'est le dénominateur réel).
    this.deps.metrics.origin();
    this.fetchOrigin(context, config, callbacks, gen, () => tier('origin'));
  }

  private nowMs(): number { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

  /** Livraison locale (cache ou pair) via onSuccess standard hls.js. */
  private deliver(bytes: Uint8Array, context: FragmentLoaderContext, callbacks: LoaderCallbacks<FragmentLoaderContext>, gen: number): void {
    if (gen !== this.gen || this.settled) return;
    this.settled = true;
    const now = performance.now();
    this.stats.loading.first = now;
    this.stats.loading.end = now;
    this.stats.loaded = bytes.length;
    this.stats.total = bytes.length;
    this.stats.chunkCount = 1;
    // Copie : hls.js peut retenir le buffer — on ne partage jamais nos octets.
    callbacks.onSuccess({ url: context.url, data: bytes.slice().buffer as ArrayBuffer, code: 200 }, this.stats, context, null);
  }

  // ---------- ORIGIN : délégation au loader natif hls.js (DefaultConfig.loader) ----------

  private fetchOrigin(context: FragmentLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<FragmentLoaderContext>, gen: number, onDelivered?: () => void): void {
    const loader = this.origin ??= this.deps.makeOrigin(this.config);
    loader.stats = this.stats; // l'observabilité du Player (bitrate, bwEstimate) reste cohérente
    loader.load(context, config, {
      onSuccess: (response, stats, ctx, networkDetails) => {
        if (gen !== this.gen || this.settled) return;
        const data = response.data;
        if (data instanceof ArrayBuffer) {
          const frag = ctx.frag as FragLite | undefined;
          if (frag && typeof frag.sn === 'number') this.deps.cacheSeed(frag.cc, frag.sn, new Uint8Array(data)); // §20 : origin → cache → annonce
        }
        this.settled = true;
        onDelivered?.(); // [mesh-test] : tier 'origin' mesuré (fin du chargement réseau)
        callbacks.onSuccess(response, stats, ctx, networkDetails);
      },
      // Signatures exactes hls.js 1.6.17 : onError(error, context, networkDetails, stats) ;
      // onTimeout/onAbort(stats, context, networkDetails).
      onError: (error, ctx, networkDetails, stats) => { if (gen === this.gen && !this.settled) { this.settled = true; callbacks.onError(error, ctx, networkDetails, stats); } },
      onTimeout: (stats, ctx, networkDetails) => { if (gen === this.gen && !this.settled) { this.settled = true; callbacks.onTimeout(stats, ctx, networkDetails); } },
      onAbort: (stats, ctx, networkDetails) => { if (gen === this.gen && !this.settled) { this.settled = true; callbacks.onAbort?.(stats, ctx, networkDetails); } },
    });
  }

  abort(): void {
    this.gen += 1; // invalide toute réponse mesh en vol (le timeout de la requête pair est borné de son côté)
    this.settled = false;
    this.origin?.abort();
  }
  destroy(): void { this.origin?.destroy(); this.origin = null; }
  getCacheAge(): number | null { return null; }
  getResponseHeader(name: string): string | null { return this.origin?.getResponseHeader?.(name) ?? null; }
}
