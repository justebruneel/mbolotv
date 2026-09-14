// ============================================================================
// Tests de TRANSPORT peer→peer (étape 4, brief §49/§50) : deux PeerLink RÉELS
// (logique de négociation + protocole + cache + hash) sur le mock fake-rtc
// (RTCPeerConnection/DataChannel simulés, file d'émission + backpressure
// pilotable + hooks de sabotage). Pas de réseau réel : c'est la LOGIQUE qu'on
// prouve. Chaque test ferme ses liens via t.after (les pings sinon gardent la
// boucle d'événements vivante).
// Lancer : node --import tsx --test packages/mesh/test/peer-transport.test.mjs
// ============================================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PeerLink } from '../src/peer-link.ts';
import { SegmentCache } from '../src/memory-cache.ts';
import { makeRtcPair, waitFor } from './fake-rtc.mjs';

const SWARM = 'ab'.repeat(16);
const SWARM2 = 'cd'.repeat(16);
const SEG = (len, fill) => Uint8Array.from({ length: len }, (_, i) => (i + fill) & 0xff);
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));

// peerIds : 22 caractères base64url (contrat). A < B lexicographiquement →
// A est l'IMPOLI (createDataChannel + offre), B est poli (répond).
const PID_A = 'peerAAAAAAAAAAAAAAAAAAAA';
const PID_B = 'peerBBBBBBBBBBBBBBBBBBBB';

async function connectedPair(t) {
  const { env, created } = makeRtcPair();
  const cacheA = new SegmentCache(SWARM, 30);
  const cacheB = new SegmentCache(SWARM, 30);
  const signals = { a: [], b: [] };
  const linkA = new PeerLink(PID_A, SWARM, null, false, cacheA, env, {
    state() {}, signal: (type, payload) => signals.a.push({ type, payload }), served() {}, downloaded() {},
  }, 65536);
  const linkB = new PeerLink(PID_B, SWARM, null, true, cacheB, env, {
    state() {}, signal: (type, payload) => signals.b.push({ type, payload }), served() {}, downloaded() {},
  }, 65536);
  t.after(() => { linkA.close(); linkB.close(); });
  linkA.initiate();
  linkB.ensurePc();
  const drain = () => {
    while (signals.a.length) { const s = signals.a.shift(); linkB.receiveSignal(s.type, s.payload); }
    while (signals.b.length) { const s = signals.b.shift(); linkA.receiveSignal(s.type, s.payload); }
  };
  await waitFor(() => { drain(); return linkA.usable && linkB.usable; }, 1000, 'lien prêt');
  return { linkA, linkB, cacheA, cacheB, pcs: created };
}

describe('transport A↔B — la preuve de concept (§49)', () => {
  it('A possède 100, B demande → B reconstruit les chunks + vérifie sha256', async (t) => {
    const { linkB, cacheA, cacheB } = await connectedPair(t);
    const bytes = SEG(300_000, 3); // 5 trames : multi-chunks réel
    await cacheA.put(0, 100, bytes, 'origin');
    linkB.knownWin = { cc: 0, first: 95, last: 100 };
    const result = await linkB.requestSegment(0, 100, 1500);
    assert.equal(result.ok, true);
    assert.ok(result.bytes && eq(result.bytes, bytes));
    await waitFor(() => cacheB.get(0, 100) !== undefined, 200, 'seed B'); // B tiendra le segment à un prochain pair
  });

  it('A ne possède pas 101 (fenêtre menteuse) → refus SEGMENT_NOT_AVAILABLE', async (t) => {
    const { linkB } = await connectedPair(t);
    linkB.knownWin = { cc: 0, first: 95, last: 105 };
    const result = await linkB.requestSegment(0, 101, 500);
    assert.equal(result.ok, false);
    // Étape 5 : SEGMENT_NOT_AVAILABLE → raison précise 'unavailable' (échec
    // SOUPLE : le pair n'a pas ce segment, normal en live — ne le condamne
    // pas). Jamais un blocage : le loader retombe origin.
    assert.equal(result.reason, 'unavailable');
  });

  it('hors fenêtre annoncée : refus AVANT tout traffic (§12 — pas de fichier arbitraire)', async (t) => {
    const { linkB, cacheA } = await connectedPair(t);
    await cacheA.put(0, 50, SEG(100, 1), 'origin'); // existe côté A mais hors de la fenêtre connue
    linkB.knownWin = { cc: 0, first: 95, last: 100 };
    const result = await linkB.requestSegment(0, 50, 500);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'refused');
  });
});

describe('échecs contrôlés (§50)', () => {
  it('octets falsifiés en vol → sha256 invalide → rejet reason:hash', async (t) => {
    const { linkB, cacheA, pcs } = await connectedPair(t);
    await cacheA.put(0, 100, SEG(10_000, 7), 'origin');
    linkB.knownWin = { cc: 0, first: 95, last: 100 };
    const emitter = pcs[0]._created; // le canal par lequel A ÉMET
    emitter._tamper = (p) => { const q = Uint8Array.from(p); q[q.length - 1] ^= 0xff; return q; };
    const result = await linkB.requestSegment(0, 100, 1000);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'hash');
  });

  it('trame perdue → timeout propre (le loader ira en origin)', async (t) => {
    const { linkB, cacheA, pcs } = await connectedPair(t);
    await cacheA.put(0, 100, SEG(200_000, 5), 'origin'); // dernière trame partielle
    for (const pc of pcs) for (const dc of [pc._created, pc._received]) if (dc) dc._drop = (p) => p.byteLength < 65_536 + 7 && p.byteLength > 7;
    linkB.knownWin = { cc: 0, first: 95, last: 100 };
    const result = await linkB.requestSegment(0, 100, 250);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'timeout');
  });

  it('pair qui meurt en pleine demande → échec, jamais de promesse pendue', async (t) => {
    const { linkA, linkB, cacheA } = await connectedPair(t);
    await cacheA.put(0, 100, SEG(2_000_000, 2), 'origin');
    linkB.knownWin = { cc: 0, first: 95, last: 100 };
    const promise = linkB.requestSegment(0, 100, 150);
    await new Promise((r) => setTimeout(r, 10));
    linkA.close('test-disparait'); // DATA CHANNEL + PC fermés chez A → B voit fermer
    const result = await promise;
    assert.equal(result.ok, false);
    assert.ok(result.reason === 'timeout' || result.reason === 'dead');
  });

  it('lien fermé avant demande : requestSegment résout dead', async (t) => {
    const { linkB } = await connectedPair(t);
    linkB.knownWin = { cc: 0, first: 95, last: 100 };
    linkB.close('test');
    const result = await linkB.requestSegment(0, 97, 100);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'dead');
  });

  it('capacity=off côté serveur (DRAIN) : rien n’est servi', async (t) => {
    const { linkA, linkB, cacheA } = await connectedPair(t);
    await cacheA.put(0, 100, SEG(5000, 9), 'origin');
    linkA.canSeed = false; // DRAIN/flag coordinateur, doublé côté émetteur (§18 déf. en profondeur)
    linkB.knownWin = { cc: 0, first: 95, last: 100 };
    const result = await linkB.requestSegment(0, 100, 300);
    assert.equal(result.ok, false);
    // DRAIN → SEGMENT_NOT_AVAILABLE → raison souple 'unavailable' (étape 5) :
    // un pair drainé ne doit PAS être marqué pourri, il ne sert juste plus.
    assert.equal(result.reason, 'unavailable');
  });

  it('pair abusif (message > 8 Ko) : fermeture du lien, pas d’exécution', async (t) => {
    const { linkA, linkB, pcs } = await connectedPair(t);
    void linkA;
    const emitter = pcs[0]._created;
    emitter.send('x'.repeat(9001)); // trop gros : B doit fermer sur abus, pas parser
    await waitFor(() => linkB.linkState === 'closed', 500, 'fermeture abus');
    assert.equal(linkB.usable, false);
  });

  it('mauvais swarm : HELLO cross-swarm ferme le lien (aucun échange)', async (t) => {
    const { env } = makeRtcPair();
    const cacheA = new SegmentCache(SWARM, 10);
    const cacheB = new SegmentCache(SWARM2, 10);
    const signals = { a: [], b: [] };
    const linkA = new PeerLink(PID_A, SWARM, null, false, cacheA, env, { state() {}, signal: (type, payload) => signals.a.push({ type, payload }), served() {}, downloaded() {} }, 65536);
    const linkB = new PeerLink(PID_B, SWARM2, null, true, cacheB, env, { state() {}, signal: (type, payload) => signals.b.push({ type, payload }), served() {}, downloaded() {} }, 65536);
    t.after(() => { linkA.close(); linkB.close(); });
    linkA.initiate(); linkB.ensurePc();
    const drain = () => {
      while (signals.a.length) { const s = signals.a.shift(); linkB.receiveSignal(s.type, s.payload); }
      while (signals.b.length) { const s = signals.b.shift(); linkA.receiveSignal(s.type, s.payload); }
    };
    await waitFor(() => { drain(); return linkB.linkState === 'closed' || linkA.linkState === 'closed'; }, 800, 'cross-swarm fermé');
    assert.equal(linkB.usable, false);
    const result = await linkB.requestSegment(0, 1, 100);
    assert.equal(result.ok, false);
  });

  it('requête dupliquée : la seconde échoue, la première aboutit (pas de double bande passante)', async (t) => {
    const { linkB, cacheA } = await connectedPair(t);
    await cacheA.put(0, 100, SEG(400_000, 11), 'origin');
    linkB.knownWin = { cc: 0, first: 95, last: 100 };
    const first = linkB.requestSegment(0, 100, 2000);
    const second = linkB.requestSegment(0, 100, 2000);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(b.ok, false); // refusée (OVERLOADED chez A ou inFlight)
    assert.equal(a.ok, true);  // l'originale aboutit normalement
  });
});

describe('backpressure (§23)', () => {
  it('buffer plein → pause du pump ; drain (bufferedamountlow) → reprise et succès', async (t) => {
    const { linkB, cacheA, pcs } = await connectedPair(t);
    const bytes = SEG(2_000_000, 4); // 31 trames > BUFFER_HIGH (1 Mo)
    await cacheA.put(0, 100, bytes, 'origin');
    linkB.knownWin = { cc: 0, first: 95, last: 100 };
    const emitter = pcs[0]._created;
    emitter.pause(); // le canal emmagasine sans livrer → bufferedAmount grimpe → pump suspendu
    const promise = linkB.requestSegment(0, 100, 3000);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(emitter.bufferedAmount > 1_000_000, 'le pump a bien atteint le seuil et marqué');
    emitter.resume(); // le drain déclenche bufferedamountlow → le pump reprend
    const result = await promise;
    assert.equal(result.ok, true);
    assert.ok(result.bytes && eq(result.bytes, bytes));
  });

  it('canal qui ne draine JAMAIS → abandon propre après le délai de drain', async (t) => {
    const { linkA, linkB, cacheA, pcs } = await connectedPair(t);
    void linkA;
    await cacheA.put(0, 100, SEG(2_000_000, 6), 'origin');
    linkB.knownWin = { cc: 0, first: 95, last: 100 };
    const emitter = pcs[0]._created;
    emitter.pause(); // jamais de reprise : le serviteur doit abandonner, pas gonfler SCTP
    const result = await linkB.requestSegment(0, 100, 400); // timeout receveur avant le drain-timeout émetteur
    assert.equal(result.ok, false);
    assert.ok(result.reason === 'timeout' || result.reason === 'refused');
  });
});
