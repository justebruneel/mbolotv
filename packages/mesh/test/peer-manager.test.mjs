// PeerManager — bornes strictes (§27 : ne dépasse jamais maxPeers) et filtres
// d'admission (soi-même, cap=off, cooldown après échec). Sans liens réels :
// les méthodes publiques d'introspection suffisent à figer la discipline.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PeerManager } from '../src/peer-manager';
import { SegmentCache } from '../src/memory-cache';
import { makeRtcPair } from './fake-rtc.mjs';

const SWARM = 'ab'.repeat(16);
const SELF = 'peerAAAAAAAAAAAAAAAAAAAA';

function managerWith(maxPeers = 4) {
  const { env } = makeRtcPair();
  return new PeerManager({
    selfPid: SELF, sid: SWARM, rid: null, cache: new SegmentCache(SWARM, 10),
    env, signals: { send() {} }, maxPeers, chunkBytes: 65536, peerTimeoutMs: 1500, cooldownMs: 60_000,
  });
}

const cand = (id, cap = 'normal', extra = {}) => ({ id, cap, proto: 1, ...extra });

describe('PeerManager — discipline des liens', () => {
  it('ne retourne jamais soi-même et plafonne à maxPeers', () => {
    const m = managerWith(2);
    m.applyCandidates([cand(SELF), cand('peerB' + 'B'.repeat(17)), cand('peerC' + 'C'.repeat(17)), cand('peerD' + 'D'.repeat(17))]);
    assert.equal(m.allPeers.length, 2); // SELF ignoré, 4ᵉ refusé : maxPeers strict
    assert.ok(!m.allPeers.includes(SELF));
    m.close();
  });

  it('cap=off jamais accepté comme lien (règle serveur doublée client)', () => {
    const m = managerWith(4);
    m.applyCandidates([cand('peerB' + 'B'.repeat(17), 'off')]);
    assert.equal(m.allPeers.length, 0);
    m.close();
  });

  it('renditions incompatibles connues : pas de lien', () => {
    const m = managerWith(4);
    m.setRid('aaaaaaaa');
    m.applyCandidates([cand('peerB' + 'B'.repeat(17), 'normal', { rid: 'bbbbbbbb' })]);
    assert.equal(m.allPeers.length, 0);
    m.applyCandidates([cand('peerC' + 'C'.repeat(17), 'normal', { rid: 'aaaaaaaa' })]);
    assert.equal(m.allPeers.length, 1); // rid égal : accepté
    m.close();
  });

  it('candidate déjà présente : fenêtre rafraîchie SANS recréer le lien', () => {
    const m = managerWith(4);
    const b = 'peerB' + 'B'.repeat(17);
    m.applyCandidates([cand(b)]);
    const before = m.allPeers.length;
    m.applyCandidates([cand(b, 'normal', { win: { cc: 0, first: 9, last: 12 } })]);
    assert.equal(m.allPeers.length, before);
    m.close();
  });

  it('remove d’un pair inconnu : silencieux', () => {
    const m = managerWith(4);
    assert.doesNotThrow(() => m.remove('peerZ' + 'Z'.repeat(17)));
  });

  it('requestSegment sans liens : échec propre, jamais une exception', async () => {
    const m = managerWith(4);
    const result = await m.requestSegment(0, 1);
    assert.equal(result.ok, false);
    m.close();
  });

  it('offre non demandée acceptée dans la limite, refusée au-delà de maxPeers', () => {
    const m = managerWith(1);
    const b = 'peerB' + 'B'.repeat(17);
    const c = 'peerC' + 'C'.repeat(17);
    m.onSignal(b, 'SIGNAL_OFFER', { sdp: 'v=0\r\nx'.repeat(5) });
    assert.equal(m.allPeers.length, 1);
    m.onSignal(c, 'SIGNAL_OFFER', { sdp: 'v=0\r\ny'.repeat(5) });
    assert.equal(m.allPeers.length, 1); // maxPeers dur : la 2ᵉ offre est ignorée
    m.close();
  });
});
