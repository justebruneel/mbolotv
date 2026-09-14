// ============================================================================
// Tests du CACHE PERSISTANT IndexedDB (étape 5). Sans navigateur : InMemoryStore
// implémente le même contrat SegmentStore (Map), donc TOUTE la logique de
// bornage/LRU/TTL/quota/erreur est prouvée ici ; seule l'ouverture réelle
// idb-keyval n'est pas testée (elle échoue → cache désactivé → mémoire continue,
// ce qu'on vérifie via `store: null`). Lancer : node --import tsx --test.
// ============================================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PersistentCache, InMemoryStore, sha256Hex } from '../src/index';

const SWARM = 'ab'.repeat(16);
const SEG = (len, fill) => Uint8Array.from({ length: len }, (_, i) => (i + fill) & 0xff);

// horloge contrôlable + store partagé pour observer les entrées brutes
function make(opts = {}) {
  let clock = opts.start ?? 1_000;
  const store = opts.store ?? new InMemoryStore();
  const cache = new PersistentCache({ swarmId: SWARM, store, now: () => clock, ...opts.cache });
  return { cache, store, tick: (ms) => { clock += ms; } };
}

describe('PersistentCache — get/put/manquants', () => {
  it('put puis get : aller-retour fidèle des octets et méta', async () => {
    const { cache } = make();
    const bytes = SEG(1000, 5);
    await cache.put(0, 100, bytes, 'origin', 'deadbeef');
    const got = await cache.get(0, 100);
    assert.ok(got);
    assert.equal(Buffer.from(got.data).equals(Buffer.from(bytes)), true);
    assert.equal(got.cc, 0);
    assert.equal(got.sn, 100);
    assert.equal(got.source, 'origin');
    assert.equal(got.rid, 'deadbeef');
    assert.equal(got.byteLength, 1000);
  });

  it('sha256 stocké = le SHA-256 standard des octets (intégrité §27)', async () => {
    const { cache } = make();
    await cache.put(0, 1, SEG(64, 1), 'peer', null);
    const got = await cache.get(0, 1);
    assert.equal(got.sha256, await sha256Hex(SEG(64, 1)));
  });

  it('miss : un (cc,sn) jamais stocké → undefined, sans lever', async () => {
    const { cache } = make();
    assert.equal(await cache.get(0, 999), undefined);
    assert.equal(await cache.has(0, 999), false);
  });

  it('clé = swarmId:cc:sn — JAMAIS l’URL (deux URLs du même segment = une entrée)', async () => {
    const { cache, store } = make();
    await cache.put(0, 42, SEG(10, 2), 'origin', null);
    assert.equal(store.size, 1);
    const meta = (await store.keys())[0];
    assert.equal(meta.key, `${SWARM}:0:42`);
    // aucune contamination par URL/signature/token dans la clé :
    assert.ok(!/x-sig|x-exp|http|:\/\//.test(meta.key));
  });
});

describe('PersistentCache — bornes strictes (LRU + taille + TTL)', () => {
  it('plafond de SEGMENTS : les moins récemment ACCÉDÉS partent en premier', async () => {
    const { cache, store, tick } = make({ cache: { maxSegments: 3, maxBytes: 1e9 } });
    for (const sn of [1, 2, 3]) { await cache.put(0, sn, SEG(50, sn), 'origin', null); tick(10); }
    // accède 1 (le plus ancien) pour le rajeunir, puis écrit 4 → la victime est 2.
    await cache.get(0, 1); tick(10);
    await cache.put(0, 4, SEG(50, 4), 'origin', null);
    await cache.evictIfNeeded();
    const sns = (await store.keys()).map((m) => m.sn).sort((a, b) => a - b);
    assert.deepEqual(sns, [1, 3, 4]); // 2 est le plus vieux accès → parti
  });

  it('plafond d’OCTETS : on rogne du moins récemment accédé', async () => {
    const { cache, store, tick } = make({ cache: { maxSegments: 100, maxBytes: 250 } });
    await cache.put(0, 1, SEG(100, 1), 'origin', null); tick(10);
    await cache.put(0, 2, SEG(100, 2), 'origin', null); tick(10);
    await cache.put(0, 3, SEG(100, 3), 'origin', null); tick(10); // total 300 > 250
    await cache.evictIfNeeded();
    const bytes = (await store.keys()).reduce((s, m) => s + m.byteLength, 0);
    assert.ok(bytes <= 250, `bytes=${bytes}`);
    const sns = (await store.keys()).map((m) => m.sn);
    assert.ok(!sns.includes(1)); // le moins récemment accédé a sauté en premier
  });

  it('TTL live (§6) : une entrée trop vieille est évincée et devient un miss', async () => {
    const { cache, store, tick } = make({ cache: { maxAgeMs: 90_000, maxSegments: 100, maxBytes: 1e9 } });
    await cache.put(0, 10, SEG(50, 1), 'origin', null);
    tick(91_000); // au-delà de maxAgeMs
    assert.equal(await cache.get(0, 10), undefined); // périmé = miss pour le loader
    await cache.evictIfNeeded();
    assert.equal(store.size, 0); // et purgé du disque
  });

  it('get() rajeunit lastAccessedAt (sémantique LRU honnête)', async () => {
    const { cache, store, tick } = make({ cache: { maxSegments: 2, maxBytes: 1e9 } });
    await cache.put(0, 1, SEG(10, 1), 'origin', null); tick(10);
    await cache.put(0, 2, SEG(10, 2), 'origin', null); tick(10);
    await cache.get(0, 1); tick(10); // accès → 1 devient plus récent que 2
    await cache.put(0, 3, SEG(10, 3), 'origin', null);
    await cache.evictIfNeeded();
    const sns = (await store.keys()).map((m) => m.sn);
    assert.ok(!sns.includes(2)); // 2 (le vrai LRU) est parti, 1 survit car touché
  });
});

describe('PersistentCache — clearSwarm & purge de session', () => {
  it("clearSwarm efface TOUTES les entrées de CE swarm", async () => {
    const { cache, store } = make();
    await cache.put(0, 1, SEG(10, 1), 'origin', null);
    await cache.put(0, 2, SEG(10, 2), 'peer', null);
    await cache.clearSwarm();
    assert.equal(store.size, 0);
    assert.equal(await cache.get(0, 1), undefined);
  });

  it('clearSwarm ne touche PAS les entrées d’un AUTRE swarm (clé préfixée)', async () => {
    const store = new InMemoryStore();
    const a = new PersistentCache({ swarmId: 'ab'.repeat(16), store });
    const b = new PersistentCache({ swarmId: 'cd'.repeat(16), store });
    await a.put(0, 1, SEG(10, 1), 'origin', null);
    await b.put(0, 1, SEG(10, 2), 'origin', null); // même (cc,sn), swarm différent
    await a.clearSwarm();
    assert.ok(await b.get(0, 1)); // l'autre swarm intact
    assert.equal(await a.get(0, 1), undefined);
  });
});

describe('PersistentCache — fail-safe (RÈGLE ABSOLUE)', () => {
  it('erreur du store → cache désactivé, JAMAIS une exception remontée', async () => {
    const store = new InMemoryStore();
    const { cache } = make({ store });
    await cache.put(0, 1, SEG(10, 1), 'origin', null); // ok
    store.failNext = true;
    await assert.doesNotReject(cache.get(0, 1)); // lit → le store casse → géré
    assert.equal(cache.active, false); // désactivé lui-même
    // et après, TOUT est un no-op sûr :
    await assert.doesNotReject(cache.put(0, 2, SEG(10, 2), 'origin', null));
    await assert.doesNotReject(cache.delete(0, 1));
    await assert.doesNotReject(cache.clearSwarm());
    await assert.doesNotReject(cache.evictIfNeeded());
    assert.equal(await cache.get(0, 1), undefined);
  });

  it('aucun store (pas d’IndexedDB) → no-op silencieux, le mémoire continuerait', async () => {
    // store: undefined + pas de globalThis.indexedDB sous Node → ouverture échoue.
    const cache = new PersistentCache({ swarmId: SWARM });
    await assert.doesNotReject(cache.put(0, 1, SEG(10, 1), 'origin', null));
    assert.equal(await cache.get(0, 1), undefined);
    assert.equal(cache.active, false); // auto-désactivé : seule la persist est morte, pas MeshStream
  });

  it('segment aberrant (0 ou > maxBytes) refusé sans erreur ni écriture', async () => {
    const { cache, store } = make({ cache: { maxBytes: 1000 } });
    await cache.put(0, 1, new Uint8Array(0), 'origin', null);
    await cache.put(0, 2, SEG(5000, 1), 'origin', null); // > maxBytes
    assert.equal(store.size, 0);
  });
});

describe('PersistentCache — statistiques & quota', () => {
  it('getStats expose entrées/octets/budgets et l’état actif', async () => {
    const { cache } = make({ cache: { maxBytes: 5000, maxSegments: 10 } });
    await cache.put(0, 1, SEG(100, 1), 'origin', null);
    await cache.put(0, 2, SEG(200, 2), 'peer', null);
    const stats = await cache.getStats();
    assert.equal(stats.entries, 2);
    assert.equal(stats.bytes, 300);
    assert.equal(stats.maxBytes, 5000);
    assert.equal(stats.maxSegments, 10);
    assert.equal(stats.disabled, false);
  });
});
