// ============================================================================
// persistent-cache.ts — Cache persistant MeshStream sur IndexedDB (étape 5).
//
// RÈGLE ABSOLUE héritée de l'étape 4 : ce fichier ne doit JAMAIS pouvoir
// casser la lecture. Toute erreur IndexedDB, tout quota dépassé, tout
// environnement sans indexedDB (Node, tests, WebView bridée) → le cache
// persistant se désactive LUI-MÊME et redevient un no-op ; le cache mémoire
// (memory-cache.ts) et l'origin continuent intacts. Aucune promesse de ce
// module ne rejette jamais : chacune résout au pire `undefined`/`false`.
//
// Identité d'une entrée : segmentKey = "swarmId:cc:sn" — JAMAIS l'URL (le
// proxy la réécrit et la re-signe à chaque requête ; deux URLs d'un même
// segment logique doivent retomber sur la MÊME entrée). La clé ne porte donc
// aucun x-exp, x-sig, domaine, tunnel, IP, ni token.
//
// Le module n'importe idb-keyval QU'À L'OUVERTURE DU VRAI STORE navigateur
// (import dynamique) : sous Node/tests (store factice injecté) et tant que le
// POC est éteint, idb-keyval n'est jamais chargé — le bundle du chemin actuel
// ne change pas (règle de l'étape 4).
// ============================================================================
import {
  MESH_PERSIST_MAX_AGE_MS,
  MESH_PERSIST_MAX_BYTES,
  MESH_PERSIST_MAX_SEGMENTS,
  MESH_PERSIST_READ_TIMEOUT_MS,
} from '@mbolo/contracts';
import { sha256Hex } from './memory-cache';

/** Ce qu'une entrée persiste. `source` trace D'OÙ viennent les octets ; aucune
 *  donnée personnelle, aucune URL, aucun token, aucun deviceId (§29 du brief). */
export interface PersistentSegment {
  key: string;
  swarmId: string;
  cc: number;
  sn: number;
  rid: string | null;
  receivedAt: number;
  lastAccessedAt: number;
  byteLength: number;
  sha256: string;
  source: 'peer' | 'origin';
  data: Uint8Array;
}

/** Ce que get() renvoie au loader (sans la copie des octets déjà faite). */
export interface PersistentSegmentMeta {
  key: string;
  cc: number;
  sn: number;
  rid: string | null;
  byteLength: number;
  sha256: string;
  source: PersistentSegment['source'];
  receivedAt: number;
  lastAccessedAt: number;
}

export interface PersistentStats {
  entries: number;
  bytes: number;
  maxBytes: number;
  maxSegments: number;
  disabled: boolean;
}

/**
 * Le store est injectable : la VRAIE implémentation (idb-keyval) n'est choisie
 * qu'en navigateur ; les tests et tout environnement sans IndexedDB passent un
 * store factice. Les méthodes sont TOUTES asynchrones et ne rejettent pas :
 * un store qui plante doit mener à `disabled`, jamais à une exception remontée.
 */
export interface SegmentStore {
  get(key: string): Promise<PersistentSegment | undefined>;
  set(entry: PersistentSegment): Promise<void>;
  delete(key: string): Promise<void>;
  /** Toutes les clés (pour l'éviction). Doit être borné en pratique par maxSegments. */
  keys(): Promise<PersistentSegmentMeta[]>;
  clear(): Promise<void>;
}

export interface PersistentCacheOptions {
  swarmId: string;
  /** Store sous-jacent. Absent → tentative d'ouvrir IndexedDB ; échec → no-op. */
  store?: SegmentStore;
  maxBytes?: number;
  maxSegments?: number;
  maxAgeMs?: number;
  readTimeoutMs?: number;
  now?: () => number;
  /** Hook télémétrie (best-effort, peut être absent). */
  onEvent?: (event: 'hit' | 'miss' | 'put' | 'evict' | 'disabled') => void;
}

/** Enveloppe toute opération d'un timeout dur. DISTINCTION IMPORTANTE :
 *  un TIMEOUT (store accroché) → fallback calme (on ne veut jamais bloquer le
 *  loader) ; mais une ERREUR du store est PROPAGÉE (rejet) pour que le
 *  persistent-cache puisse se mettre en `disabled`. Avaler l'erreur masquerait
 *  un IndexedDB cassé derrière un faux « miss » éternel. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
    // ne retiens pas le process Node (timers de test)
    (timer as unknown as { unref?: () => void }).unref?.();
    promise.then(
      (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } },
      (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } }, // erreur = propagée (→ disable)
    );
  });
}

/**
 * Cache persistant borné (LRU + TTL + plafond d'octets + plafond de segments),
 * auto-désactivant. Les décisions d'éviction se prennent en tâche de fond
 * (fire-and-forget après un put) pour ne jamais bloquer la livraison d'un
 * segment ; une erreur d'éviction ne casse rien.
 */
export class PersistentCache {
  private readonly swarmId: string;
  private readonly maxBytes: number;
  private readonly maxSegments: number;
  private readonly maxAgeMs: number;
  private readonly readTimeoutMs: number;
  private readonly now: () => number;
  private readonly onEvent?: (event: 'hit' | 'miss' | 'put' | 'evict' | 'disabled') => void;
  private storePromise: Promise<SegmentStore | null> | null = null;
  private injectedStore: SegmentStore | null;
  private disabled = false;

  constructor(options: PersistentCacheOptions) {
    this.swarmId = options.swarmId;
    this.maxBytes = options.maxBytes ?? MESH_PERSIST_MAX_BYTES;
    this.maxSegments = options.maxSegments ?? MESH_PERSIST_MAX_SEGMENTS;
    this.maxAgeMs = options.maxAgeMs ?? MESH_PERSIST_MAX_AGE_MS;
    this.readTimeoutMs = options.readTimeoutMs ?? MESH_PERSIST_READ_TIMEOUT_MS;
    this.now = options.now ?? ((): number => Date.now());
    this.onEvent = options.onEvent;
    this.injectedStore = options.store ?? null;
  }

  /** Le cache est-il utilisable (jamais true si l'ouverture a échoué). */
  get active(): boolean { return !this.disabled; }

  keyFor(cc: number, sn: number): string { return `${this.swarmId}:${cc}:${sn}`; }

  /** Résout le store à utiliser, une seule fois. Le store injecté (tests) est
   *  roi ; sinon ouverture paresseuse d'IndexedDB via idb-keyval. Toute erreur
   *  (dont absence d'indexedDB) met le cache en mode no-op DÉFINITIF (§ Règle). */
  private async store(): Promise<SegmentStore | null> {
    if (this.disabled) return null;
    if (this.injectedStore) return this.injectedStore;
    if (!this.storePromise) {
      this.storePromise = (async (): Promise<SegmentStore | null> => {
        try {
          if (typeof indexedDB === 'undefined') throw new Error('no-indexeddb');
          const { createStore, get: rawGet, set: rawSet, del: rawDel, keys: rawKeys, clear: rawClear } = await import('idb-keyval');
          const store = createStore('mbolo-mesh', 'segments');
          return {
            get: (key) => rawGet<PersistentSegment>(key, store),
            set: (entry) => rawSet(entry.key, entry, store),
            delete: (key) => rawDel(key, store),
            // keys() ne rend que les clés ; on reconstruit les méta depuis les
            // objets stockés — borné en pratique par maxSegments (< 100).
            keys: async (): Promise<PersistentSegmentMeta[]> => {
              const all = await rawKeys(store);
              const out: PersistentSegmentMeta[] = [];
              for (const raw of all) {
                const entry = await rawGet<PersistentSegment>(raw as string, store);
                if (entry) out.push(toMeta(entry));
              }
              return out;
            },
            clear: () => rawClear(store),
          };
        } catch {
          this.disable();
          return null;
        }
      })();
    }
    return this.storePromise;
  }

  /** Désactivation définitive et propre : le reste de MeshStream continue sans
   *  cache persistant (mémoire + origin sont intacts — règle n°1). */
  private disable(): void {
    if (this.disabled) return;
    this.disabled = true;
    this.onEvent?.('disabled');
  }

  async get(cc: number, sn: number): Promise<PersistentSegment | undefined> {
    const store = await this.store();
    if (!store) { this.onEvent?.('miss'); return undefined; }
    try {
      const entry = await withTimeout(store.get(this.keyFor(cc, sn)), this.readTimeoutMs, undefined);
      if (!entry) { this.onEvent?.('miss'); return undefined; }
      if (this.now() - entry.receivedAt > this.maxAgeMs) {
        // Périmé : purge en tâche de fond, traité comme un miss pour le loader.
        void this.delete(cc, sn);
        this.onEvent?.('miss');
        return undefined;
      }
      void this.touch(cc, sn, entry);
      this.onEvent?.('hit');
      return entry;
    } catch {
      this.disable();
      this.onEvent?.('miss');
      return undefined;
    }
  }

  /** Promotion mémoire→disque appelée par le client : écrit l'entrée si dans le
   *  budget, puis déclenche l'éviction en arrière-plan. Ne rejette JAMAIS. */
  async put(cc: number, sn: number, bytes: Uint8Array, source: 'peer' | 'origin', rid: string | null): Promise<void> {
    const store = await this.store();
    if (!store) return;
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxBytes) return; // segment aberrant : non stockable, sans erreur
    try {
      const stamp = this.now();
      const entry: PersistentSegment = {
        key: this.keyFor(cc, sn),
        swarmId: this.swarmId,
        cc,
        sn,
        rid,
        receivedAt: stamp,
        lastAccessedAt: stamp,
        byteLength: bytes.byteLength,
        sha256: await sha256Hex(bytes),
        source,
        data: bytes.slice(), // copie : on ne partage jamais le buffer du loader avec IDB
      };
      await withTimeout(store.set(entry), this.readTimeoutMs * 4, undefined);
      this.onEvent?.('put');
      void this.evictIfNeeded(); // tâche secondaire — ne bloque jamais le prochain segment
    } catch {
      this.disable();
    }
  }

  async has(cc: number, sn: number): Promise<boolean> { return Boolean(await this.get(cc, sn)); }

  async delete(cc: number, sn: number): Promise<void> {
    const store = await this.store();
    if (!store) return;
    try { await withTimeout(store.delete(this.keyFor(cc, sn)), this.readTimeoutMs, undefined); }
    catch { this.disable(); }
  }

  /** Purge TOUTES les entrées de CE swarm : quitté (LEAVE) ou rendition
   *  changée (les (cc,sn) passés ne sont plus compatibles). Le cache reste
   *  borné dans le temps ET l'espace : rien ne survit à un swarm qu'on quitte. */
  async clearSwarm(): Promise<void> {
    const store = await this.store();
    if (!store) return;
    try {
      const metas = await withTimeout(store.keys(), this.readTimeoutMs * 4, [] as PersistentSegmentMeta[]);
      for (const meta of metas.filter((m) => this.keyFor(m.cc, m.sn) === m.key)) {
        await withTimeout(store.delete(meta.key), this.readTimeoutMs, undefined).catch(() => { /* ignore */ });
      }
    } catch { this.disable(); }
  }

  async clearAll(): Promise<void> {
    const store = await this.store();
    if (!store) return;
    try { await withTimeout(store.clear(), this.readTimeoutMs * 4, undefined); }
    catch { this.disable(); }
  }

  /** Éviction LRU bornée : TTL d'abord (le live meurt vite), puis plafond de
   *  segments, puis plafond d'octets — dans cet ordre, en supprimant les moins
   *  récemment ACCÉDÉS. Best-effort : toute erreur désactive sans remonter. */
  async evictIfNeeded(): Promise<void> {
    const store = await this.store();
    if (!store) return;
    try {
      const now = this.now();
      let metas = await withTimeout(store.keys(), this.readTimeoutMs * 4, [] as PersistentSegmentMeta[]);
      // 1. TTL : tout ce qui a dépassé maxAgeMs part, quel que soit le reste.
      const expired = metas.filter((m) => now - m.receivedAt > this.maxAgeMs);
      for (const m of expired) await withTimeout(store.delete(m.key), this.readTimeoutMs, undefined).catch(() => { /* ignore */ });
      metas = metas.filter((m) => now - m.receivedAt <= this.maxAgeMs);
      // 2. Plafond de segments : on garde les plus récemment accédés.
      const byAccess = [...metas].sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
      if (byAccess.length > this.maxSegments) {
        for (const m of byAccess.slice(this.maxSegments)) await withTimeout(store.delete(m.key), this.readTimeoutMs, undefined).catch(() => { /* ignore */ });
      }
      // 3. Plafond d'octets : on rogne du moins récemment accédé vers le plus récent.
      let bytes = byAccess.reduce((sum, m) => sum + m.byteLength, 0);
      let idx = byAccess.length - 1;
      while (idx >= 0 && bytes > this.maxBytes) {
        const m = byAccess[idx];
        bytes -= m.byteLength;
        await withTimeout(store.delete(m.key), this.readTimeoutMs, undefined).catch(() => { /* ignore */ });
        this.onEvent?.('evict');
        idx -= 1;
      }
    } catch { this.disable(); }
  }

  async getStats(): Promise<PersistentStats> {
    const store = await this.store();
    if (!store) return { entries: 0, bytes: 0, maxBytes: this.maxBytes, maxSegments: this.maxSegments, disabled: true };
    try {
      const metas = await withTimeout(store.keys(), this.readTimeoutMs * 4, [] as PersistentSegmentMeta[]);
      return {
        entries: metas.length,
        bytes: metas.reduce((sum, m) => sum + m.byteLength, 0),
        maxBytes: this.maxBytes,
        maxSegments: this.maxSegments,
        disabled: false,
      };
    } catch { this.disable(); return { entries: 0, bytes: 0, maxBytes: this.maxBytes, maxSegments: this.maxSegments, disabled: true }; }
  }

  /** lastAccessedAt mis à jour SANS attendre (fire-and-forget) : une lecture
   *  ne doit jamais bloquer sur une écriture de bookkeeping. */
  private touch(cc: number, sn: number, entry: PersistentSegment): Promise<void> {
    const store = this.injectedStore ?? null;
    if (!store) return Promise.resolve();
    return withTimeout(store.set({ ...entry, lastAccessedAt: this.now() }), this.readTimeoutMs, undefined)
      .then(() => undefined)
      .catch(() => { this.disable(); });
  }
}

function toMeta(entry: PersistentSegment): PersistentSegmentMeta {
  return {
    key: entry.key,
    cc: entry.cc,
    sn: entry.sn,
    rid: entry.rid,
    byteLength: entry.byteLength,
    sha256: entry.sha256,
    source: entry.source,
    receivedAt: entry.receivedAt,
    lastAccessedAt: entry.lastAccessedAt,
  };
}

// ---------------------------------------------------------------------------
// Store factice pour Node/tests (et éventuel repli) : Map en mémoire exposée
// sous la forme SegmentStore. Le cache persistant "fonctionne" dessus (get/put/
// evict) sans rien toucher d'IndexedDB — c'est ce qui permet de tester toute
// la logique de bornage/LRU/TTL hors navigateur.
// ---------------------------------------------------------------------------
export class InMemoryStore implements SegmentStore {
  private map = new Map<string, PersistentSegment>();
  failNext = false; // hook de test : force une erreur d'IO au prochain appel

  async get(key: string): Promise<PersistentSegment | undefined> {
    if (this.failNext) throw new Error('store-failure');
    return this.map.get(key);
  }
  async set(entry: PersistentSegment): Promise<void> {
    if (this.failNext) throw new Error('store-failure');
    this.map.set(entry.key, { ...entry, data: entry.data.slice() });
  }
  async delete(key: string): Promise<void> {
    if (this.failNext) throw new Error('store-failure');
    this.map.delete(key);
  }
  async keys(): Promise<PersistentSegmentMeta[]> {
    if (this.failNext) throw new Error('store-failure');
    return [...this.map.values()].map((e) => toMeta(e));
  }
  async clear(): Promise<void> {
    if (this.failNext) throw new Error('store-failure');
    this.map.clear();
  }
  get size(): number { return this.map.size; }
}
