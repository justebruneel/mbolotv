// ============================================================================
// Tests d'INTÉGRATION étape 5 : sélection adaptative des pairs (§21-24) et
// hiérarchie du loader mémoire→IDB→pairs→origin (§7) avec backoff adaptatif
// (§25). Les liens sont simulés (objets légers) : on prouve l'ALGORITHME de
// sélection et la DÉCISION du loader, pas la WebRTC (déjà couverte par
// peer-transport.test.mjs). Lancer : node --import tsx --test.
// ============================================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PeerManager, MeshLoader, PeerScore, SegmentCache, InMemoryStore, PersistentCache } from '../src/index';
import { MESH_SCORE_DEFAULTS } from '@mbolo/contracts';

const SWARM = 'ab'.repeat(16);
const SELF = 'peerAAAAAAAAAAAAAAAAAAAA';
const fakeLink = (usable = true, inFlight = 0, rttMs = null) => ({ usable, inFlight, rttMs, pid: '', close() {}, knownWin: null });

function mgr(overrides = {}) {
  return new PeerManager({
    selfPid: SELF, sid: SWARM, rid: null, cache: new SegmentCache(SWARM, 10),
    env: {}, signals: { send() {} }, maxPeers: 4, chunkBytes: 65536, peerTimeoutMs: 1500,
    now: () => 1000, ...overrides,
  });
}

// Injecte des pairs « prêts » dans la map privée du manager pour tester rank()
// via requestSegment sans négocier de vraie WebRTC (rank/score = la logique).
function inject(m, pid, { cap = 'normal', win = { cc: 0, first: 90, last: 110 }, usable = true, prepared = false } = {}) {
  const score = new PeerScore(pid, cap, () => 1000, undefined);
  if (prepared) for (let i = 0; i < 4; i += 1) score.recordSuccess(500_000, 500);
  m.peers.set(pid, { link: { ...fakeLink(usable), pid, knownWin: win }, cap, win, failedAt: null, score });
  return score;
}

describe('Sélection §21-24 — le pair au MEILLEUR score est tenté en premier', () => {
  it('pair prêt > pair inconnu : le requestSegment vise d’abord celui qui livre', async () => {
    const m = mgr();
    inject(m, 'peerBBBBBBBBBBBBBBBBBBBB', { prepared: true }); // score élevé
    inject(m, 'peerCCCCCCCCCCCCCCCCCCCC'); // jamais testé
    let order = 0; const seen = [];
    for (const { link } of m.peers.values()) { const orig = link.requestSegment; link.requestSegment = async (cc, sn) => { seen.push([++order, sn]); return orig ? orig() : { ok: false, reason: 'timeout' }; }; }
    // On force le lien prêt à renvoyer un segment : c'est LUI qu'on doit appeler.
    const ready = m.peers.get('peerBBBBBBBBBBBBBBBBBBBB');
    ready.link.requestSegment = async () => { seen.push(['ready']); return { ok: true, bytes: new Uint8Array([7, 7]) }; };
    m.peers.get('peerCCCCCCCCCCCCCCCCCCCC').link.requestSegment = async () => { seen.push(['weak']); return { ok: false, reason: 'timeout' }; };
    const res = await m.requestSegment(0, 100);
    assert.equal(res.ok, true);
    assert.deepEqual(seen[0], ['ready']); // le meilleur score tenté en premier
    m.close();
  });

  it('pair hors fenêtre annoncée ÉCARTÉ (§21 pas.4) : on ne demande pas ce qu’il n’a pas', async () => {
    const m = mgr();
    const out = inject(m, 'peerBBBBBBBBBBBBBBBBBBBB', { prepared: true, win: { cc: 0, first: 90, last: 100 } });
    void out;
    m.peers.get('peerBBBBBBBBBBBBBBBBBBBB').link.requestSegment = async () => ({ ok: true, bytes: new Uint8Array([1]) });
    // On demande sn=150, hors [90..100] : écarté → aucun pair → 'dead'.
    const res = await m.requestSegment(0, 150);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'dead');
    m.close();
  });

  it('pair EN COOLDOWN ignoré (§14) : UNRELIABLE n’est pas retenté', async () => {
    const m = mgr({});
    inject(m, 'peerBBBBBBBBBBBBBBBBBBBB', { prepared: true });
    const b = m.peers.get('peerBBBBBBBBBBBBBBBBBBBB');
    b.link.requestSegment = async () => ({ ok: true, bytes: new Uint8Array([1]) });
    // Mettons-le en cooldown par 3 échecs durs (unreliableAfter défaut 3) :
    b.score.recordFailure('timeout'); b.score.recordFailure('timeout'); b.score.recordFailure('timeout');
    assert.equal(b.score.cooling, true);
    const res = await m.requestSegment(0, 95); // dans sa fenêtre, mais refroidi
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'dead'); // aucun pair sélectionnable
    m.close();
  });

  it('pair cap=off jamais sélectionné (règle serveur doublée client)', async () => {
    const m = mgr();
    const off = inject(m, 'peerBBBBBBBBBBBBBBBBBBBB', { prepared: true, cap: 'off' });
    void off;
    const res = await m.requestSegment(0, 95);
    assert.equal(res.ok, false);
    m.close();
  });

  it('≤ 2 pairs tentés par segment (§24) : jamais une rafale sur tous', async () => {
    const m = mgr();
    let calls = 0;
    for (const id of ['peerBBBBBBBBBBBBBBBBBBBB', 'peerCCCCCCCCCCCCCCCCCCCC', 'peerDDDDDDDDDDDDDDDDDDDD', 'peerEEEEEEEEEEEEEEEEEEEEEE']) {
      inject(m, id, { prepared: true });
      m.peers.get(id).link.requestSegment = async () => { calls += 1; return { ok: false, reason: 'timeout' }; };
    }
    await m.requestSegment(0, 95);
    assert.equal(calls, 2); // exactement deux tentatives, pas quatre
    m.close();
  });
});

describe('Sélection §23 — diversité déterministe', () => {
  it('scores ÉQUIVALENTS → rotation (pas toujours le même seeder)', () => {
    const m = mgr();
    // Deux pairs identiques (même score, même fenêtre) : le curseur alterne.
    for (const id of ['peerBBBBBBBBBBBBBBBBBBBB', 'peerCCCCCCCCCCCCCCCCCCCC']) inject(m, id, { prepared: true });
    const firstChoices = new Set();
    for (let i = 0; i < 8; i += 1) {
      const ranked = m['rank'](0, 95); // accès à la méthode (private levée par tsx)
      if (ranked[0]) firstChoices.add(ranked[0].link.pid);
    }
    assert.equal(firstChoices.size, 2, `diversité attendue, obtenu ${firstChoices.size}`);
    m.close();
  });

  it('diversité bornée par epsilon : un pair NETTEMENT meilleur gagne toujours', () => {
    const m = mgr();
    inject(m, 'peerBBBBBBBBBBBBBBBBBBBB', { prepared: true }); // score ~1
    inject(m, 'peerCCCCCCCCCCCCCCCCCCCC'); // score faible (jamais testé)
    const picks = new Set();
    for (let i = 0; i < 6; i += 1) picks.add(m['rank'](0, 95)[0]?.link.pid);
    assert.deepEqual([...picks], ['peerBBBBBBBBBBBBBBBBBBBB']); // pas de rotation hors plateau
    m.close();
  });
});

describe('bestScore + §25 backoff : seuil de confiance', () => {
  it('bestScore = max des scores de pairs usables', () => {
    const m = mgr();
    inject(m, 'peerBBBBBBBBBBBBBBBBBBBB', { prepared: true });
    inject(m, 'peerCCCCCCCCCCCCCCCCCCCC');
    assert.ok(m.bestScore() > MESH_SCORE_DEFAULTS.trustThreshold); // pair prêt > seuil
    m.close();
  });
  it('aucun pair → bestScore 0 (loader ne parie pas)', () => {
    const m = mgr();
    assert.equal(m.bestScore(), 0);
    m.close();
  });
});

// ------------------------------------------------------------ LOADER (§7/§25)
function fakeOrigin(bytes = new Uint8Array([9, 9, 9])) {
  return {
    stats: { loaded: 0, total: 0, chunkCount: 0, retry: 0, aborted: false, bwEstimate: 0, loading: {}, parsing: {}, buffering: {} },
    load(_ctx, _cfg, cb) { setTimeout(() => cb.onSuccess({ data: bytes.slice().buffer }, this.stats, _ctx, null), 0); },
    abort() {}, destroy() {}, getResponseHeader: () => null,
  };
}

describe('Loader §7 — hiérarchie mémoire → IDB → pairs → origin', () => {
  it('mémoire hit → servi, JAMAIS IDB ni pair consultés (§26)', async () => {
    let idb = 0; let peers = 0;
    const m = { cacheHit: 0, idbHit: 0, origin: 0 };
    const loader = new MeshLoader({
      makeOrigin: () => fakeOrigin(), allowed: () => true, started: () => true, bufferOk: () => true, liveEdgeOk: () => true,
      cacheGet: () => new Uint8Array([1, 2, 3]),
      cacheGetPersistent: async () => { idb += 1; return null; },
      cacheSeed: () => {}, requestSegment: async () => { peers += 1; return { ok: false }; },
      metrics: { cacheHit: () => { m.cacheHit += 1; }, origin: () => { m.origin += 1; }, idbHit: () => { m.idbHit += 1; } },
    }, {});
    const out = await new Promise((res, rej) => loader.load({ frag: { sn: 5, cc: 0 }, url: 'x', responseType: 'arraybuffer', headers: {} }, { loadPolicy: {} }, { onSuccess: (r) => res(new Uint8Array(r.data)), onError: rej, onTimeout: rej, onAbort: rej }));
    assert.deepEqual([...out], [1, 2, 3]);
    assert.equal(idb, 0); assert.equal(peers, 0); assert.equal(m.cacheHit, 1);
  });

  it('miss mémoire, IDB hit → servi + PROMOUVOIR en mémoire, pairs non touchés (§26)', async () => {
    let peers = 0; const promoted = [];
    const loader = new MeshLoader({
      makeOrigin: () => fakeOrigin(), allowed: () => true, started: () => true, bufferOk: () => true, liveEdgeOk: () => true,
      cacheGet: () => null,
      cacheGetPersistent: async () => new Uint8Array([4, 5, 6]),
      promoteMemory: (cc, sn, b) => promoted.push([cc, sn, [...b]]),
      cacheSeed: () => {}, requestSegment: async () => { peers += 1; return { ok: false }; },
      metrics: { cacheHit() {}, origin() {}, idbHit() {} },
    }, {});
    const out = await new Promise((res, rej) => loader.load({ frag: { sn: 7, cc: 0 }, url: 'x', responseType: 'arraybuffer', headers: {} }, { loadPolicy: {} }, { onSuccess: (r) => res(new Uint8Array(r.data)), onError: rej, onTimeout: rej, onAbort: rej }));
    assert.deepEqual([...out], [4, 5, 6]);
    assert.equal(peers, 0, 'IDB servi → pas de pari pair');
    assert.equal(promoted.length, 1);
  });

  it('mémoire+IDB miss, pair OK → servi + seed ; pair KO → origin', async () => {
    const seeds = [];
    const build = (peer) => new Promise((res, rej) => new MeshLoader({
      makeOrigin: () => fakeOrigin(new Uint8Array([8, 8])), allowed: () => true, started: () => true, bufferOk: () => true, liveEdgeOk: () => true,
      cacheGet: () => null, cacheGetPersistent: async () => null, cacheSeed: (cc, sn) => seeds.push([cc, sn]),
      requestSegment: peer, metrics: { cacheHit() {}, origin() {}, idbHit() {} },
    }, {}).load({ frag: { sn: 3, cc: 0 }, url: 'x', responseType: 'arraybuffer', headers: {} }, { loadPolicy: {} }, { onSuccess: (r) => res(new Uint8Array(r.data)), onError: rej, onTimeout: rej, onAbort: rej }));
    const viaPeer = await build(async () => ({ ok: true, bytes: new Uint8Array([1, 1]) }));
    assert.deepEqual([...viaPeer], [1, 1]);
    assert.deepEqual(seeds[0], [0, 3]); // seed origin? non : seed pair → cacheSeed appelé par le loader pair
    const viaOrigin = await build(async () => ({ ok: false, reason: 'timeout' }));
    assert.deepEqual([...viaOrigin], [8, 8]);
  });

  it('buffer critique → JAMAIS de pari pair (garde §8), origine directe', async () => {
    let peers = 0;
    await new Promise((res, rej) => new MeshLoader({
      makeOrigin: () => fakeOrigin(), allowed: () => true, started: () => true, bufferOk: () => false, liveEdgeOk: () => true,
      cacheGet: () => null, cacheGetPersistent: async () => null, cacheSeed: () => {},
      requestSegment: async () => { peers += 1; return { ok: true, bytes: new Uint8Array([1]) }; },
      metrics: { cacheHit() {}, origin() {}, idbHit() {} },
    }, {}).load({ frag: { sn: 4, cc: 0 }, url: 'x', responseType: 'arraybuffer', headers: {} }, { loadPolicy: {} }, { onSuccess: () => res(), onError: rej, onTimeout: rej, onAbort: rej }));
    assert.equal(peers, 0, 'buffer bas → pas de pari, même si pair dispo');
  });

  it('allowed() faux (backoff/sous-seuil §25) → cache tenté puis origin, pairs NON consultés', async () => {
    let peers = 0;
    await new Promise((res, rej) => new MeshLoader({
      makeOrigin: () => fakeOrigin(), allowed: () => false, started: () => true, bufferOk: () => true, liveEdgeOk: () => true,
      cacheGet: () => null, cacheGetPersistent: async () => null, cacheSeed: () => {},
      requestSegment: async () => { peers += 1; return { ok: false }; }, metrics: { cacheHit() {}, origin() {}, idbHit() {} },
    }, {}).load({ frag: { sn: 4, cc: 0 }, url: 'x', responseType: 'arraybuffer', headers: {} }, { loadPolicy: {} }, { onSuccess: () => res(), onError: rej, onTimeout: rej, onAbort: rej }));
    assert.equal(peers, 0);
  });

  it('segment chiffré / init / byte-range → JAMAIS le mesh (origin direct)', async () => {
    let cacheLookups = 0;
    const probe = (frag) => new Promise((res, rej) => new MeshLoader({
      makeOrigin: () => fakeOrigin(), allowed: () => true, started: () => true, bufferOk: () => true, liveEdgeOk: () => true,
      cacheGet: () => { cacheLookups += 1; return null; }, cacheGetPersistent: async () => null, cacheSeed: () => {},
      requestSegment: async () => ({ ok: true, bytes: new Uint8Array([1]) }), metrics: { cacheHit() {}, origin() {}, idbHit() {} },
    }, {}).load(frag, { loadPolicy: {} }, { onSuccess: () => res(), onError: rej, onTimeout: rej, onAbort: rej }));
    await probe({ frag: { sn: 5, cc: 0, encrypted: true }, url: 'x', responseType: 'arraybuffer', headers: {} });
    await probe({ frag: { sn: 'initSegment', cc: 0 }, url: 'x', responseType: 'arraybuffer', headers: {} });
    await probe({ frag: { sn: 5, cc: 0 }, rangeStart: 100, url: 'x', responseType: 'arraybuffer', headers: {} });
    assert.equal(cacheLookups, 0, 'aucun de ces cas ne doit toucher la hierarchie');
  });
});

describe('Loader §7 — l’IDB qui plante ne casse RIEN (fail-safe)', () => {
  it('cacheGetPersistent qui REJETTE → traité comme un miss, on continue vers les pairs/origin', async () => {
    let reachedOrigin = false;
    await new Promise((res, rej) => new MeshLoader({
      makeOrigin: () => { reachedOrigin = true; return fakeOrigin(); }, allowed: () => true, started: () => true, bufferOk: () => true, liveEdgeOk: () => true,
      cacheGet: () => null,
      cacheGetPersistent: async () => { throw new Error('IDB cassé'); },
      cacheSeed: () => {}, requestSegment: async () => ({ ok: false, reason: 'timeout' }), metrics: { cacheHit() {}, origin() {}, idbHit() {} },
    }, {}).load({ frag: { sn: 9, cc: 0 }, url: 'x', responseType: 'arraybuffer', headers: {} }, { loadPolicy: {} }, { onSuccess: () => res(), onError: () => res(), onTimeout: () => res(), onAbort: () => res() }));
    assert.equal(reachedOrigin, true, 'erreur IDB → repli, jamais un échec de lecture');
  });
});

// ------------------------------------------------------------ PROMOTION réel
describe('PersistentCache + loader : promotion mémoire après hit IDB (§26)', () => {
  it('un segment persistant se relit et remonte en mémoire', async () => {
    const store = new InMemoryStore();
    const cache = new SegmentCache(SWARM, 5);
    const persist = new PersistentCache({ swarmId: SWARM, store });
    const bytes = Uint8Array.from({ length: 200 }, (_, i) => i & 0xff);
    await persist.put(0, 50, bytes, 'origin', null);
    // Le loader (session) lirait mémoire (miss) puis IDB (hit) puis promoteMemory.
    assert.equal(cache.get(0, 50), undefined);
    const entry = await persist.get(0, 50);
    assert.ok(entry);
    await cache.put(0, 50, entry.data, 'cache'); // ce que fait client.promoteMemory
    assert.ok(cache.get(0, 50)); // désormais en mémoire
  });
});
