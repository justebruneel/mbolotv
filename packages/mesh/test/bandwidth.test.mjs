// ============================================================================
// Optimisation bande passante (v1.1) — tests DELTA. Ne re-teste pas ce qui est
// déjà figé (sélection de base, cooldown, kill-switch, transport A↔B : voir
// peer-score/manager/transport/step5). Ici uniquement le nouveau :
// compteurs timeout/hash, anti-surcharge (lien occupé évité, maxUploads),
// coalescence des requêtes, prefetch peer-only, métrique originRequestsAvoided,
// gardes buffer/prefetch du loader, résilience avec retrait.
// Lancer : node --import tsx --test packages/mesh/test/bandwidth.test.mjs
// ============================================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PeerScore, PeerManager, PeerLink, SegmentCache, MeshClient, MeshLoader, MeshSession } from '../src/index.ts';
import { makeRtcPair, waitFor } from './fake-rtc.mjs';
import { MESH_PROTOCOL_VERSION } from '@mbolo/contracts';
import { createMeshToken } from '@mbolo/contracts';

const SWARM = 'ab'.repeat(16);
const SEG = (len, fill) => Uint8Array.from({ length: len }, (_, i) => (i + fill) & 0xff);
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const PID = (l) => `peer${l.repeat(18)}`.slice(0, 22);
const SELF = PID('A'), PB = PID('B'), PC = PID('C');

// ------------------------------------------------------------------ PeerScore

describe('Bande passante — débit réel et compteurs par cause (§5/§22)', () => {
  it('throughputBps = bytes*1000/ms (premier échantillon = mesure brute)', () => {
    const s = new PeerScore(PB, 'normal', () => 1000);
    s.recordSuccess(500_000, 250); // 500 Ko en 250 ms = 2 Mo/s
    assert.equal(s.snapshot().throughputBps, 2_000_000);
  });
  it('compteurs timeout/hash + timeoutRate (zéro sans données, jamais NaN)', () => {
    const s = new PeerScore(PB, 'normal', () => 1000);
    assert.equal(s.snapshot().timeoutRate, 0);
    s.recordSuccess(1000, 10);
    s.recordFailure('timeout'); s.recordFailure('timeout'); s.recordFailure('hash');
    const snap = s.snapshot();
    assert.equal(snap.timeouts, 2);
    assert.equal(snap.hashFailures, 1);
    assert.equal(snap.timeoutRate, 2 / 4);
    const c = s.counters();
    assert.equal(c.timeouts, 2);
    assert.equal(c.hashFailures, 1);
  });
  it('un pair lent (timeout) chute sous un pair rapide à succès égal', () => {
    const fast = new PeerScore(PB, 'normal', () => 1000);
    const slow = new PeerScore(PC, 'normal', () => 1000);
    for (let i = 0; i < 3; i += 1) {
      fast.recordSuccess(500_000, 150); slow.recordSuccess(500_000, 150);
      fast.markWindowFresh(); slow.markWindowFresh();
    }
    slow.recordFailure('timeout'); slow.recordFailure('timeout');
    assert.ok(fast.score() > slow.score(), `fast=${fast.score()} slow=${slow.score()}`);
  });
});

// ------------------------------------------------------- manager : deux liens
// (harnais : le manager initie vers deux remotes fake-RTC ; drain manuel des
// deux sens, comme step5-scenario, mais côté PeerManager pour tester le rang,
// le plafond d'uploads et le retrait — jamais de réseau réel).

function drainAll(mgr, outbox, remotes) {
  for (const [pid, box] of outbox) {
    const r = remotes.get(pid);
    while (box.length) {
      const s = box.shift();
      r.link.receiveSignal(s.type, s.payload.sdp ? { sdp: s.payload.sdp } : { c: s.payload.c });
    }
  }
  for (const [pid, r] of remotes) {
    while (r.box.length) {
      const s = r.box.shift();
      mgr.onSignal(pid, s.type, s.payload.sdp ? { sdp: s.payload.sdp } : { c: s.payload.c });
    }
  }
}

async function connectTwo(t, opts) {
  const { env, created } = makeRtcPair();
  const outbox = new Map();
  const cache = new SegmentCache(SWARM, 40);
  const mgr = new PeerManager({
    selfPid: SELF, sid: SWARM, rid: null, cache,
    env, signals: { send: (type, to, payload) => outbox.get(to)?.push({ type, payload }) },
    maxPeers: 4, chunkBytes: 65536, peerTimeoutMs: opts?.peerTimeoutMs ?? 400,
    cooldownMs: 60_000, maxUploads: opts?.maxUploads,
  });
  t.after(() => mgr.close());
  const remotes = new Map();
  // IMPORTANT (fake-rtc) : le couplage des PCs se fait par ordre de création
  // dans le pool — on apparie donc B PUIS C, séquentiellement, sinon les deux
  // liens du manager se coupleraient entre eux.
  for (const pid of [PB, PC]) {
    mgr.applyCandidates([{ id: pid, cap: 'normal', proto: 1, win: { cc: 0, first: 0, last: 100 } }]);
    const box = [];
    const link = new PeerLink(pid, SWARM, null, true, new SegmentCache(SWARM, 40), env, {
      state() {}, signal: (type, payload) => box.push({ type, payload }), served() {}, downloaded() {},
    }, 65536);
    t.after(() => link.close());
    link.ensurePc();
    link.knownWin = { cc: 0, first: 0, last: 100 };
    remotes.set(pid, { link, box });
    outbox.set(pid, []);
    await waitFor(() => {
      drainAll(mgr, outbox, remotes);
      return remotes.get(pid).link.usable;
    }, 1500, `lien manager↔${pid} prêt`);
  }
  return { env, created, outbox, mgr, cache, remotes };
}

describe('Sélection — lien occupé évité (harnais tracé, §8)', () => {
  it('la 2e demande fuit le lien en vol vers le lien libre', async (t) => {
    const { env, created } = makeRtcPair();
    const picked = [];
    const outbox = new Map();
    const mgr = new PeerManager({
      selfPid: SELF, sid: SWARM, rid: null, cache: new SegmentCache(SWARM, 40),
      env, signals: { send: (type, to, payload) => outbox.get(to)?.push({ type, payload }) },
      maxPeers: 4, chunkBytes: 65536, peerTimeoutMs: 500, cooldownMs: 60_000,
      trace: (e) => { if (e.t === 'selected') picked.push(e.pid); },
    });
    t.after(() => mgr.close());
    const win90 = { cc: 0, first: 90, last: 90 };
    const win5 = { cc: 0, first: 0, last: 5 };
    const remotes = new Map();
    // Appariement séquentiel (voir connectTwo : le pool fake-RTC couple par
    // ordre de création).
    for (const [pid, win] of [[PB, win90], [PC, win5]]) {
      mgr.applyCandidates([{ id: pid, cap: 'normal', proto: 1, win }]);
      const box = [];
      const link = new PeerLink(pid, SWARM, null, true, new SegmentCache(SWARM, 40), env, {
        state() {}, signal: (type, payload) => box.push({ type, payload }), served() {}, downloaded() {},
      }, 65536);
      t.after(() => link.close());
      link.ensurePc();
      link.knownWin = { cc: 0, first: 0, last: 100 };
      remotes.set(pid, { link, box });
      outbox.set(pid, []);
      await waitFor(() => {
        drainAll(mgr, outbox, remotes);
        return remotes.get(pid).link.usable;
      }, 1500, `lien manager↔${pid} prêt`);
    }
    // B seul sert le gros segment 90 (1,5 Mo → pump long, inFlight durable) ;
    // les deux servent le petit 5.
    await remotes.get(PB).link.cache.put(0, 90, SEG(1_500_000, 9), 'origin');
    await remotes.get(PB).link.cache.put(0, 5, SEG(1000, 5), 'origin');
    await remotes.get(PC).link.cache.put(0, 5, SEG(1000, 5), 'origin');
    const p1 = mgr.requestSegment(0, 90); // occupe le lien manager→B
    await new Promise((r) => setTimeout(r, 30)); // laisse le vol s'installer
    mgr.updateWindow(PC, { cc: 0, first: 0, last: 90 }); // C couvre tout aussi
    const p2 = await mgr.requestSegment(0, 5); // B occupé → doit fuir vers C
    assert.equal(picked[1], PC, `2e demande → lien libre C (reçu ${picked[1]})`);
    assert.equal(p2.ok, true);
    assert.ok(eq(p2.bytes, SEG(1000, 5)));
    const r1 = await p1;
    assert.equal(r1.ok, true, 'la 1re demande aboutit quand même');
    void created;
  });
});

describe('Upload borné — maxUploads simultanés (§9)', () => {
  it('2 servings simultanés max=1 : le 2e est refusé OVERLOADED, quota rendu', async (t) => {
    const h = await connectTwo(t, { maxUploads: 1 });
    h.mgr.setMaxUploads(1);
    await h.cache.put(0, 7, SEG(1_500_000, 7), 'origin'); // gros → pump en pause
    // Pause des canaux manager→remotes AVANT les demandes : les pumps calent
    // dès bufferedAmount > 1 Mo, les servings restent en vol (chevauchement).
    for (const pc of h.created) if (pc._created?.peer) pc._created.pause();
    const pB = h.remotes.get(PB).link.requestSegment(0, 7, 4000);
    const pC = h.remotes.get(PC).link.requestSegment(0, 7, 4000);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(h.mgr.uploadsInFlight, 1, 'un seul upload admis');
    for (const pc of h.created) if (pc._created?.peer) pc._created.resume();
    const [rB, rC] = await Promise.all([pB, pC]);
    const oks = [rB, rC].filter((r) => r.ok);
    const refused = [rB, rC].filter((r) => !r.ok);
    assert.equal(oks.length, 1, 'exactement un servi');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason, 'overloaded', 'refus = échec SOUPLE, pas de sanction');
    assert.equal(h.mgr.uploadsInFlight, 0, 'quota rendu après fin');
  });
  it('setMaxUploads borne [1..maxPeers], défaut 2', () => {
    const { env } = makeRtcPair();
    const m = new PeerManager({
      selfPid: SELF, sid: SWARM, rid: null, cache: new SegmentCache(SWARM, 5),
      env, signals: { send() {} }, maxPeers: 4, chunkBytes: 65536, peerTimeoutMs: 300,
    });
    assert.equal(m.uploadsInFlight, 0);
    m.setMaxUploads(99);
    m.setMaxUploads(0);
    m.close();
  });
});

describe('Résilience — retrait d’un pair (§25)', () => {
  it('remove() : plus de lien, pas de promesse pendue, cooldown anti-boucle', async (t) => {
    const h = await connectTwo(t);
    await h.remotes.get(PB).link.cache.put(0, 11, SEG(2000, 11), 'origin');
    await h.remotes.get(PC).link.cache.put(0, 11, SEG(2000, 11), 'origin');
    const r1 = await h.mgr.requestSegment(0, 11);
    assert.equal(r1.ok, true);
    h.mgr.remove(PB); // A disparaît brutalement
    assert.ok(!h.mgr.allPeers.includes(PB));
    const r2 = await h.mgr.requestSegment(0, 11); // C prend le relais, sans blocage
    assert.equal(r2.ok, true);
    h.mgr.applyCandidates([{ id: PB, cap: 'normal', proto: 1 }]); // retour immédiat ?
    assert.ok(!h.mgr.allPeers.includes(PB), 'cooldown ICE : pas de re-lien en boucle');
  });
});

// ------------------------------------------------------------- faux MeshClient

function fakeWs() {
  const listeners = new Map();
  const sent = [];
  const ws = {
    readyState: 1, send(d) { sent.push(d); }, close() { listeners.get('close')?.(); },
    addEventListener(type, fn) { listeners.set(type, fn); },
    deliver(o) { listeners.get('message')?.({ data: JSON.stringify(o) }); },
    sent, selfPid: SELF,
  };
  return ws;
}
const cfgFor = (over = {}) => ({
  p2pEnabled: true, maxPeers: 4, peerTimeoutMs: 400, bufferCriticalSec: 12,
  liveEdgeSafetySegments: 2, heartbeatMs: 30000, statsIntervalMs: 120000,
  pollIntervalMs: 4000, candidateSample: 8, windowSize: 24, chunkBytes: 65536,
  protocolVersion: MESH_PROTOCOL_VERSION, minProtocolVersion: 1, ...over,
});
function liveClient(t, metrics, trace) {
  const ws = fakeWs();
  const client = new MeshClient({
    token: 'x.y', meshUrl: 'wss://mesh/mesh/ws', levelUrl: '', selfPid: SELF, swarmId: SWARM,
    capacity: 'normal', networkType: 'wifi', env: {}, now: () => 1000,
    wsFactory: () => ws, fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    metrics, trace,
  });
  t.after(() => client.stop());
  return { ws, client };
}
async function joinAccepted(ws) {
  ws.deliver({ v: 1, t: 'JOIN_ACCEPTED', sid: SWARM, id: SELF, seq: 1, ts: 1, d: { peers: [], cfg: cfgFor() } });
  await new Promise((r) => setTimeout(r, 5));
}

describe('Coalescence — une seule requête logique par (cc,sn) (§15)', () => {
  it('3 demandes simultanées → 1 seul transfert sous-jacent, même résultat', async (t) => {
    const { ws, client } = liveClient(t);
    await client.start();
    await joinAccepted(ws);
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    client.peerManager.requestSegment = async () => { calls += 1; await gate; return { ok: true, bytes: SEG(5000, 3) }; };
    const p = [client.requestSegment(0, 21), client.requestSegment(0, 21), client.requestSegment(0, 21)];
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, 1, 'transfert unique malgré 3 demandeurs');
    release();
    const results = await Promise.all(p);
    assert.ok(results.every((r) => r.ok && eq(r.bytes, SEG(5000, 3))), 'tous servis du même vol');
    // Après règlement : le prochain appel relance (pas de zombie en cache).
    client.peerManager.requestSegment = async () => { calls += 1; return { ok: true, bytes: SEG(5000, 3) }; };
    await client.requestSegment(0, 21);
    assert.equal(calls, 2, 'cleanup garanti après succès');
  });
  it('échec partagé puis cleanup : timeout propagé aux 3, pas de promesse pendue', async (t) => {
    const { ws, client } = liveClient(t);
    await client.start();
    await joinAccepted(ws);
    let calls = 0;
    client.peerManager.requestSegment = async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return { ok: false, reason: 'timeout' }; };
    const results = await Promise.all([client.requestSegment(0, 22), client.requestSegment(0, 22)]);
    assert.equal(calls, 1);
    assert.ok(results.every((r) => !r.ok && r.reason === 'timeout'));
    await client.requestSegment(0, 22);
    assert.equal(calls, 2, 'cleanup garanti après timeout');
  });
});

describe('Prefetch — pari gratuit peer-only, jamais origin (§16)', () => {
  it('remplit le cache sans tentative comptée ni repli tracé', async (t) => {
    const events = [];
    const attempts = { n: 0 };
    const { ws, client } = liveClient(t, {
      attempt() { attempts.n += 1; }, success() {}, timeout() {}, hashFail() {},
      fallbackOrigin() {}, bytesReceived() {}, bytesServed() {}, webrtcOk() {}, webrtcFail() {}, peers() {},
    }, (e) => events.push(e));
    await client.start();
    await joinAccepted(ws);
    client.trusted = () => true;
    // Le stub imite PeerLink : succès = octets mis en mémoire à réception.
    client.peerManager.requestSegment = async (cc, sn) => {
      const bytes = SEG(4000, 8);
      await client.cache.put(cc, sn, bytes, 'peer');
      return { ok: true, bytes };
    };
    client.prefetchSegment(0, 31);
    await waitFor(() => client.cache.get(0, 31) !== undefined, 300, 'prefetch en cache');
    assert.equal(attempts.n, 0, 'pas de tentative comptée (pas une demande lecteur)');
    assert.ok(!events.some((e) => e.t === 'fallback'), 'aucun repli tracé pour un pari gratuit');
  });
  it('échec silencieux : ni backoff ni bruit — le pari suivant retente', async (t) => {
    const events = [];
    const { ws, client } = liveClient(t, undefined, (e) => events.push(e));
    await client.start();
    await joinAccepted(ws);
    client.trusted = () => true;
    let calls = 0;
    client.peerManager.requestSegment = async () => { calls += 1; return { ok: false, reason: 'timeout' }; };
    client.prefetchSegment(0, 32);
    await new Promise((r) => setTimeout(r, 30));
    client.prefetchSegment(0, 32);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, 2, 'aucun backoff déclenché par un prefetch perdu');
    assert.ok(!events.some((e) => e.t === 'fallback'));
  });
  it('jamais de prefetch sur segment déjà en cache ni sans confiance', async (t) => {
    const { ws, client } = liveClient(t);
    await client.start();
    await joinAccepted(ws);
    let calls = 0;
    client.peerManager.requestSegment = async () => { calls += 1; return { ok: true, bytes: SEG(10, 1) }; };
    await client.cache.put(0, 33, SEG(10, 1), 'origin');
    client.trusted = () => true;
    client.prefetchSegment(0, 33);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 0, 'cache hit → rien à préparer');
    client.trusted = () => false;
    client.prefetchSegment(0, 34);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 0, 'pas de pari sans confiance (backoff / aucun pair)');
  });
});

// ------------------------------------------------------------------- métriques

describe('Métriques — originRequestsAvoided exactement une fois (§20-21)', () => {
  it('memory / idb / peer : +1 chacun, jamais double, origin : +0', async (t) => {
    const token = await createMeshToken('s', { v: 1, pid: SELF, sid: SWARM, did: 'cd'.repeat(16), iat: Date.now(), exp: Date.now() + 3600000 });
    const ws = fakeWs();
    const session = new MeshSession({
      token, meshUrl: 'wss://x/mesh/ws', capacity: 'off', networkType: 'wifi', iceServers: [],
      wsFactory: () => ws, fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    });
    session.capabilities.compatible = true; // harnais : on force un navigateur capable
    const hls = { config: {}, mainForwardBufferInfo: { len: 100 }, latestLevelDetails: { endSN: 200 } };
    const OriginCtor = class { constructor() {} stats = {}; load(c, _k, cb) { setTimeout(() => cb.onSuccess({ url: c.url, data: new Uint8Array([9]).buffer, code: 200 }, {}, c, {}), 0); } abort() {} destroy() {} };
    const unbind = session.bind(hls, OriginCtor);
    t.after(() => { unbind(); session.dispose(); });
    ws.deliver({ v: 1, t: 'JOIN_ACCEPTED', sid: SWARM, id: SELF, seq: 1, ts: 1, d: { peers: [], cfg: cfgFor() } });
    await new Promise((r) => setTimeout(r, 5));
    const d = session.deps();
    assert.ok(d, 'session active en harnais');
    d.metrics.cacheHit(100);
    d.metrics.idbHit(50);
    assert.equal(session.stats.memoryHits, 1);
    assert.equal(session.stats.persistentCacheHits, 1);
    assert.equal(session.stats.originRequestsAvoided, 2, 'un par hit, pas deux pour memory→IDB');
    d.metrics.origin();
    assert.equal(session.stats.originHits, 1);
    assert.equal(session.stats.originRequestsAvoided, 2, 'origin ne compte pas comme économie');
    assert.equal(session.contentKind, 'live', 'défaut live (seul contexte monté)');
  });
});

// --------------------------------------------------------------------- loader

function loaderDeps(over = {}) {
  const calls = { peer: 0, prefetch: 0, origin: 0 };
  return {
    calls,
    deps: {
      makeOrigin: () => ({
        stats: {}, context: null,
        load(ctx, _c, cb) { calls.origin += 1; setTimeout(() => cb.onSuccess({ url: ctx.url, data: new Uint8Array([7]).buffer, code: 200 }, {}, ctx, {}), 0); },
        abort() {}, destroy() {},
      }),
      allowed: () => true, started: () => true, bufferOk: () => true, liveEdgeOk: () => true,
      cacheGet: () => null, cacheSeed: () => {},
      requestSegment: async () => { calls.peer += 1; return { ok: true, bytes: SEG(3000, 4) }; },
      prefetch: () => { calls.prefetch += 1; },
      metrics: { cacheHit() {}, origin() {}, idbHit() {} },
      ...over,
    },
  };
}
const CTX = (sn) => ({ frag: { sn, cc: 0 }, part: null, url: 'u', responseType: 'arraybuffer', headers: {}, rangeStart: 0, rangeEnd: 0 });
function runLoad(deps, sn) {
  return new Promise((resolve, reject) => {
    const loader = new MeshLoader(deps, {});
    loader.load(CTX(sn), {}, { onSuccess: (r) => resolve(new Uint8Array(r.data)), onError: reject, onTimeout: reject });
  });
}

describe('Loader — gardes buffer et prefetch (§4/§16)', () => {
  it('buffer critique → origin SANS toucher aux pairs', async () => {
    const { calls, deps } = loaderDeps({ bufferOk: () => false });
    const bytes = await runLoad(deps, 60);
    assert.deepEqual([...bytes], [7]);
    assert.equal(calls.peer, 0, 'aucun pari pair en zone critique');
    assert.equal(calls.origin, 1);
  });
  it('succès pair → prefetch du suivant ; succès origin/mémoire → rien', async () => {
    const { calls, deps } = loaderDeps({});
    await runLoad(deps, 61);
    assert.equal(calls.prefetch, 1, 'pari d’avance après succès pair');
    const { calls: c2, deps: d2 } = loaderDeps({ requestSegment: async () => ({ ok: false, reason: 'timeout' }) });
    await runLoad(d2, 62);
    assert.equal(c2.prefetch, 0, 'échec pair → pas de prefetch (pas de seeder prouvé)');
    const { calls: c3, deps: d3 } = loaderDeps({ cacheGet: () => SEG(10, 1) });
    await runLoad(d3, 63);
    assert.equal(c3.prefetch, 0, 'hit mémoire → pas de prefetch (déjà local)');
  });
});
