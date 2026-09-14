// ============================================================================
// Tests de l'INSTRUMENTATION [mesh-test] (étape 6 §8). On prouve que le sink
// de trace reçoit les événements attendus sur un lien simulé (ice → dc → hello
// → peerResult), et — CRITIQUE — qu'il ne contient JAMAIS de secret : ni token,
// ni IP, ni URL fournisseur, ni deviceId dans la charge JSON. Lancer :
// node --import tsx --test test/trace.test.mjs
// ============================================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PeerLink, SegmentCache } from '../src/index';
import { makeRtcPair, waitFor } from './fake-rtc.mjs';
import { PeerScore } from '../src/peer-score';

const SWARM = 'ab'.repeat(16);
const SEG = (len, fill) => Uint8Array.from({ length: len }, (_, i) => (i + fill) & 0xff);
const PID_A = `peer${'A'.repeat(18)}`;
const PID_B = `peer${'B'.repeat(18)}`;

describe('Instrumentation §8 — le sink [mesh-test] est alimenté', () => {
  it('un transfert A→B émet ice + dc + hello + peerResult, sans aucune donnée sensible', async (t) => {
    const { env } = makeRtcPair();
    const cacheA = new SegmentCache(SWARM, 30);
    const cacheB = new SegmentCache(SWARM, 30);
    const events = [];
    const trace = (e) => events.push(e);
    const q = { a: [], b: [] };
    const linkA = new PeerLink(PID_A, SWARM, null, false, cacheA, env, { state() {}, signal: (_ty, p) => q.a.push({ _ty, p }), served() {}, downloaded() {}, trace }, 65536);
    const linkB = new PeerLink(PID_B, SWARM, null, true, cacheB, env, { state() {}, signal: (_ty, p) => q.b.push({ _ty, p }), served() {}, downloaded() {}, trace }, 65536);
    t.after(() => { linkA.close(); linkB.close(); });
    linkA.initiate(); linkB.ensurePc();
    const drain = () => {
      while (q.a.length) { const { _ty, p } = q.a.shift(); linkB.receiveSignal(_ty, p); }
      while (q.b.length) { const { _ty, p } = q.b.shift(); linkA.receiveSignal(_ty, p); }
    };
    await waitFor(() => { drain(); return linkA.usable && linkB.usable; }, 1000, 'liens prêts');
    await cacheA.put(0, 100, SEG(5000, 4), 'origin');
    linkB.knownWin = { cc: 0, first: 95, last: 100 };
    const res = await linkB.requestSegment(0, 100, 800);
    assert.equal(res.ok, true);

    const kinds = new Set(events.map((e) => e.t));
    assert.ok(kinds.has('ice'), `ice émis : ${[...kinds]}`);
    assert.ok(kinds.has('dc'), `dc émis`);
    assert.ok(kinds.has('hello'), `hello émis`);
    assert.ok(kinds.has('peerResult'), `peerResult émis`);
    const peerResult = events.find((e) => e.t === 'peerResult' && e.bytes > 0);
    assert.ok(peerResult.bytes >= 5000, 'octets transférés mesurés');
    assert.ok(peerResult.ms >= 0, 'durée mesurée');

    // SÉCURITÉ §8 : la charge sérialisée d'AUCUN événement ne doit contenir un
    // secret. On injecte des sentinelles qui NE doivent JAMAIS apparaître.
    const blob = JSON.stringify(events);
    for (const forbidden of [PID_A + '-token', 'x-sig', 'x-exp', 'http://', 'https://', '.cloudflared', 'stun:', 'turn:', 'deviceId', 'password', 'Bearer', '10.0.', '192.168.', '127.0.0.1']) {
      assert.ok(!blob.includes(forbidden), `fuite §8 : ${forbidden}`);
    }
    // Les seuls identifiants présents sont des peerId éphémères (attendus).
    assert.ok(kinds.has('ice'));
  });
});

describe('Instrumentation — skipped + selected émis par rank()', () => {
  it('pair en cooldown → skipped{cooldown}, pair retenu → selected', async () => {
    const { PeerManager } = await import('../src/index');
    const events = [];
    const trace = (e) => events.push(e);
    let clock = 1000;
    const m = new PeerManager({
      selfPid: PID_A, sid: SWARM, rid: null, cache: new SegmentCache(SWARM, 5),
      env: {}, signals: { send() {} }, maxPeers: 4, chunkBytes: 65536, peerTimeoutMs: 1500, now: () => clock, trace,
    });
    const mk = (pid, cap = 'normal') => ({ link: { usable: true, inFlight: 0, rttMs: 10, pid, knownWin: { cc: 0, first: 90, last: 110 }, close() {}, requestSegment: async () => ({ ok: true, bytes: new Uint8Array([1]) }) }, cap, win: { cc: 0, first: 90, last: 110 }, failedAt: null, score: new PeerScore(pid, cap, () => clock) });
    const ready = mk(PID_B);
    const cooling = mk(`peer${'C'.repeat(18)}`);
    cooling.score.recordFailure('timeout'); cooling.score.recordFailure('hash'); cooling.score.recordFailure('timeout'); // → cooldown
    m.peers.set(PID_B, ready);
    m.peers.set(cooling.link.pid, cooling);
    const res = await m.requestSegment(0, 100);
    assert.equal(res.ok, true);
    assert.ok(events.some((e) => e.t === 'skipped' && e.why === 'cooldown'), 'pair refroidi signalé skipped');
    assert.ok(events.some((e) => e.t === 'selected' && e.pid === PID_B), 'pair retenu signalé selected');
    assert.ok(typeof events.find((e) => e.t === 'selected').score === 'number', 'score numérique présent');
    m.close();
  });
});
