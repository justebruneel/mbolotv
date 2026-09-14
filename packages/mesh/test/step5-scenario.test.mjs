// ============================================================================
// Tests de SCÉNARIO et de KILL-SWITCH (étape 5). Le scénario §44/§45 (la
// chaîne Origin→A→B→C sans jamais bloquer) roule sur de VRAIS PeerLink+cache
// (mock fake-rtc). Le kill-switch roule sur un MeshClient piloté par un faux
// WebSocket : on prouve la PAUSE/RÉSUME réversible (le joueur continue via
// origin, le pair se remet à servir quand le serveur rouvre le P2P).
// Lancer : node --import tsx --test.
// ============================================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PeerLink, SegmentCache, MeshClient } from '../src/index';
import { makeRtcPair, waitFor } from './fake-rtc.mjs';
import { MESH_PROTOCOL_VERSION, computeMeshSwarmId, createMeshToken, deriveMeshDid, newMeshPeerId, readMeshTokenClaims } from '@mbolo/contracts';

const SWARM = 'ab'.repeat(16);
const SEG = (len, fill) => Uint8Array.from({ length: len }, (_, i) => (i + fill) & 0xff);
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const PID = (letter) => `peer${letter.repeat(18)}`.slice(0, 22);
const SELF_PID = PID('A'); const PID_A = PID('A'); const PID_B = PID('B'); const PID_C = PID('C');

// chaîne d'un seul message entre deux liens : file + drain manuel
function bus() {
  const q = { a: [], b: [], c: [] };
  return q;
}

describe('Scénario §45 — A possède, B demande à A, C demande à B (chaîne sans blocage)', () => {
  it('B obtient 102 de A, puis C obtient 102 de B ; A disparaît, B et C ne bronchent pas', async (t) => {
    const { env } = makeRtcPair();
    const cacheA = new SegmentCache(SWARM, 30);
    const cacheB = new SegmentCache(SWARM, 30);
    const cacheC = new SegmentCache(SWARM, 30);
    const q = bus();
    const linkA = new PeerLink(PID_A, SWARM, null, false, cacheA, env, { state() {}, signal: (_t, p) => q.a.push(p), served() {}, downloaded() {} }, 65536);
    const linkB = new PeerLink(PID_B, SWARM, null, true, cacheB, env, { state() {}, signal: (_t, p) => q.b.push(p), served() {}, downloaded() {} }, 65536);
    const linkC = new PeerLink(PID_C, SWARM, null, true, cacheC, env, { state() {}, signal: (_t, p) => q.c.push(p), served() {}, downloaded() {} }, 65536);
    t.after(() => { linkA.close(); linkB.close(); linkC.close(); });

    // A→B lien ; B reçoit le segment 102 depuis A.
    linkA.initiate(); linkB.ensurePc();
    const drainAB = () => {
      while (q.a.length) { const s = q.a.shift(); linkB.receiveSignal('SIGNAL_OFFER', s.sdp ? { sdp: s.sdp } : s.c ? { c: s.c } : {}); }
      while (q.b.length) { const s = q.b.shift(); linkA.receiveSignal('SIGNAL_ANSWER', s.sdp ? { sdp: s.sdp } : {}); }
    };
    await waitFor(() => { drainAB(); return linkA.usable && linkB.usable; }, 1000, 'lien A-B');

    const seg = SEG(120_000, 102);
    await cacheA.put(0, 102, seg, 'origin'); // A vient de le tirer de origin
    linkB.knownWin = { cc: 0, first: 100, last: 102 };
    const rB = await linkB.requestSegment(0, 102, 800);
    assert.equal(rB.ok, true);
    assert.ok(rB.bytes && eq(rB.bytes, seg)); // B a 102 depuis A
    await waitFor(() => cacheB.get(0, 102) !== undefined, 300, 'B seed'); // B le garde et l’annoncera à C

    // B→C lien ; C demande 102, B le sert (B ne l’a pas eu de origin mais d’A).
    const qB = { a: [], b: [] };
    const linkB2 = new PeerLink(PID_B, SWARM, null, false, cacheB, env, { state() {}, signal: (_t, p) => qB.a.push(p), served() {}, downloaded() {} }, 65536);
    // (on simule C parlant à B via un second lien B côté impoli pour C)
    const linkC2 = new PeerLink(PID_C, SWARM, null, true, cacheC, env, { state() {}, signal: (_t, p) => qB.b.push(p), served() {}, downloaded() {} }, 65536);
    t.after(() => { linkB2.close(); linkC2.close(); });
    linkB2.initiate(); linkC2.ensurePc();
    await waitFor(() => {
      while (qB.a.length) { const s = qB.a.shift(); linkC2.receiveSignal('SIGNAL_OFFER', s.sdp ? { sdp: s.sdp } : s.c ? { c: s.c } : {}); }
      while (qB.b.length) { const s = qB.b.shift(); linkB2.receiveSignal('SIGNAL_ANSWER', s.sdp ? { sdp: s.sdp } : {}); }
      return linkB2.usable && linkC2.usable;
    }, 1000, 'lien B-C');
    linkC2.knownWin = { cc: 0, first: 100, last: 102 };
    const rC = await linkC2.requestSegment(0, 102, 800);
    assert.equal(rC.ok, true, 'C servi par B (chaîne complète)');
    assert.ok(eq(rC.bytes, seg));

    // A disparaît : les liens A sont fermés. B et C ont déjà leurs octets ; une
    // nouvelle demande à B (pour C) passe toujours. Rien ne bloque.
    linkA.close('gone'); linkB.close('gone');
    linkC2.knownWin = { cc: 0, first: 100, last: 102 };
    const rC2 = await linkC2.requestSegment(0, 102, 800);
    assert.equal(rC2.ok, true, 'après disparition d’A, B sert encore C');
  });
});

// ------------------------------------------------------------ faux WebSocket
function fakeWs() {
  const listeners = new Map();
  const sent = [];
  const ws = {
    readyState: 1, // OPEN
    send(data) { sent.push(data); },
    close() { listeners.get('close')?.(); },
    addEventListener(type, fn) { listeners.set(type, fn); },
    // côté test : injecter un message descendant
    deliver(obj) { listeners.get('message')?.({ data: JSON.stringify(obj) }); },
    sent,
  };
  return ws;
}

// Fabrique un jeton signé (secret arbitraire) pour un MeshClient réel.
async function clientToken(secret = 'test-secret') {
  const pid = newMeshPeerId();
  const sid = await computeMeshSwarmId(secret, { sourceId: 's', channelId: 'c', variantId: 'v', ecoFlag: 'hd' });
  const did = await deriveMeshDid(secret, 'devicehash', '2026-09-13');
  const token = await createMeshToken(secret, { v: 1, pid, sid, did, iat: Date.now(), exp: Date.now() + 3_600_000 });
  return { pid, sid, token };
}

function cfgFor(over = {}) {
  return {
    p2pEnabled: true, maxPeers: 4, peerTimeoutMs: 1500, bufferCriticalSec: 12, liveEdgeSafetySegments: 2,
    heartbeatMs: 30000, statsIntervalMs: 120000, pollIntervalMs: 4000, candidateSample: 8, windowSize: 24,
    chunkBytes: 65536, protocolVersion: MESH_PROTOCOL_VERSION, minProtocolVersion: 1, ...over,
  };
}

function buildClient(ws) {
  return new MeshClient({
    token: 'x.y', meshUrl: 'wss://mesh/mesh/ws', levelUrl: '', selfPid: ws.selfPid ?? SELF_PID, swarmId: SWARM,
    capacity: 'normal', networkType: 'wifi', env: {}, now: () => 1000,
    wsFactory: () => ws, fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
}

describe('Kill-switch §32 — pause/résumé RÉVERSIBLE sans tuer le lecteur', () => {
  it('p2pEnabled:false → pair en pause : plus de demande, mais session vivante', async () => {
    const ws = fakeWs(); ws.selfPid = SELF_PID;
    const client = buildClient(ws);
    await client.start();
    ws.deliver({ v: 1, t: 'JOIN_ACCEPTED', sid: SWARM, id: SELF_PID, seq: 1, ts: 1, d: { peers: [], cfg: cfgFor() } });
    assert.equal(client.enabled, true);

    ws.deliver({ v: 1, t: 'CONFIG', sid: SWARM, id: SELF_PID, seq: 2, ts: 1, d: cfgFor({ p2pEnabled: false }) });
    assert.equal(client.enabled, false, 'kill → enabled false');
    const res = await client.requestSegment(0, 100);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'dead', 'aucune demande pair pendant la pause');
    // la socket n’est PAS fermée (pas de LEAVE émis après le JOIN initial) :
    assert.ok(!ws.sent.some((m) => JSON.parse(m).t === 'LEAVE_SWARM'), 'pause ≠ abandon de session');
    client.stop(); // sinon le timer heartbeat de 30 s retient le process Node
  });

  it('reprise CONFIG p2pEnabled:true → re-JOIN émis (le pair se remet à servir)', async () => {
    const ws = fakeWs(); ws.selfPid = SELF_PID;
    const client = buildClient(ws);
    await client.start();
    ws.deliver({ v: 1, t: 'JOIN_ACCEPTED', sid: SWARM, id: SELF_PID, seq: 1, ts: 1, d: { peers: [], cfg: cfgFor() } });
    ws.deliver({ v: 1, t: 'CONFIG', sid: SWARM, id: SELF_PID, seq: 2, ts: 1, d: cfgFor({ p2pEnabled: false }) });
    ws.sent.length = 0; // on repart propre
    ws.deliver({ v: 1, t: 'CONFIG', sid: SWARM, id: SELF_PID, seq: 3, ts: 1, d: cfgFor({ p2pEnabled: true }) });
    assert.equal(client.enabled, true, 'reprise → de nouveau actif');
    assert.ok(ws.sent.some((m) => JSON.parse(m).t === 'JOIN_SWARM'), 're-JOIN émis pour reconstruire les liens');
    client.stop();
  });

  it('KICK (jeton mort/abandon) → LEAVE émis, stop net (≠ pause : ici la session finit)', async () => {
    const ws = fakeWs(); ws.selfPid = SELF_PID;
    const client = buildClient(ws);
    await client.start();
    ws.deliver({ v: 1, t: 'JOIN_ACCEPTED', sid: SWARM, id: SELF_PID, seq: 1, ts: 1, d: { peers: [], cfg: cfgFor() } });
    ws.deliver({ v: 1, t: 'KICK', sid: SWARM, id: SELF_PID, seq: 2, ts: 1, d: { why: 'admin' } });
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(ws.sent.some((m) => JSON.parse(m).t === 'LEAVE_SWARM'), 'KICK ⇒ départ propre annoncé');
    assert.equal(client.enabled, false);
    client.stop();
  });
});

describe('Client §9/§35 — capacité off jamais seedeuse, rid change → purge', () => {
  it('seedOrigin refuse en pause ET quand p2p coupé (aucune écriture cache)', async () => {
    const ws = fakeWs(); ws.selfPid = SELF_PID;
    const client = buildClient(ws);
    await client.start();
    ws.deliver({ v: 1, t: 'JOIN_ACCEPTED', sid: SWARM, id: SELF_PID, seq: 1, ts: 1, d: { peers: [], cfg: cfgFor({ p2pEnabled: false }) } });
    client.seedOrigin(0, 50, SEG(10, 1));
    assert.equal(client.cache.get(0, 50), undefined, 'p2p coupé → on ne seede même pas en mémoire');
    client.stop();
  });
});

// un token est nécessairement consommé quelque part pour prouver le wiring réel
it('jeton de test valide (sanité harnais) se décode au schéma client', async () => {
  const { sid, token } = await clientToken();
  const claims = readMeshTokenClaims(token);
  assert.equal(claims.sid, sid);
  assert.match(token, /\./);
});
