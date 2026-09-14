// ============================================================================
// Tests du SCORING EWMA des pairs (étape 5, peer-score.ts). Scoring pure et
// locale : aucune WebRTC, aucun réseau. On fige les règles du brief §10-§18 :
// succès↑, échec↓, débit/RTT/fraîcheur montent dans le score, 3 échecs durs →
// UNRELIABLE + cooldown, réhabilitation après cooldown (rechute → plus long),
// échecs SOUPLES (overloaded/unavailable) ne condamnent pas, capacity off → 0.
// ============================================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PeerScore } from '../src/peer-score';

const PID = 'peerAAAAAAAAAAAAAAAAAAAA';
function score(cap = 'normal', now = () => clock, config) {
  let clock = 1_000;
  const s = new PeerScore(PID, cap, () => clock, config);
  return { s, tick: (ms) => { clock += ms; } };
}

describe('PeerScore — score initial et effets de base', () => {
  it('pair jamais testé : score intermédiaire (on lui laisse sa chance), fiable', () => {
    const { s } = score('normal');
    assert.ok(s.score() > 0 && s.score() < 1);
    assert.equal(s.reliable, true);
    assert.equal(s.state(), 'unknown');
  });

  it('success↑ : un succès strictement au-dessus de l’état inconnu', () => {
    const { s } = score('normal');
    const before = s.score();
    s.recordSuccess(500_000, 500); // ~8 Mbps
    assert.ok(s.score() > before, `after=${s.score()} before=${before}`);
    assert.equal(s.state(), 'healthy');
  });

  it('failure↓ : un échec dur fait baisser le score', () => {
    const { s } = score('normal');
    s.recordSuccess(500_000, 500);
    const afterOk = s.score();
    s.recordFailure('timeout');
    assert.ok(s.score() < afterOk);
  });

  it('throughput : un pair rapide bat un pair lent (autres choses égales)', () => {
    const fast = score('normal').s;
    const slow = score('normal').s;
    for (let i = 0; i < 6; i += 1) { fast.recordSuccess(800_000, 400); slow.recordSuccess(40_000, 400); } // 16 Mbps vs 0.8 Mbps
    assert.ok(fast.score() > slow.score(), `fast=${fast.score()} slow=${slow.score()}`);
  });

  it('RTT : un pair répondant vite bat un pair lent à transfert égal', () => {
    const fast = score('normal').s;
    const slow = score('normal').s;
    for (let i = 0; i < 6; i += 1) {
      fast.recordSuccess(400_000, 400); fast.recordRtt(10);
      slow.recordSuccess(400_000, 400); slow.recordRtt(900);
    }
    assert.ok(fast.score() > slow.score());
  });

  it('fraîcheur : une fenêtre qui vient d’être rafraîchie bat une fenêtre vieille', () => {
    const { s, tick } = score('normal', undefined, { windowStaleMs: 60_000 });
    s.markWindowFresh();
    const freshScore = s.score();
    tick(59_000); // fenêtre presque périmée
    assert.ok(s.score() < freshScore, `aged=${s.score()} fresh=${freshScore}`);
  });
});

describe('PeerScore — EWMA convergente (jamais un seul transfert = vérité)', () => {
  it('8→0.1→8 Mbit : l’EWMA lisse, ne suit pas le dernier pic', () => {
    const { s } = score('normal', undefined, { alpha: 0.3 });
    s.recordSuccess(800_000, 400); // 2 Mbps (1er échantillon = valeur brute)
    const first = s.factors().throughput;
    s.recordSuccess(40_000, 400);  // 0.1 Mbps → chute : lissée (pas 0.1 pur)
    const dip = s.factors().throughput;
    assert.ok(dip < first && dip > 0); // a baissé sans s'effondrer
    s.recordSuccess(800_000, 400); // 2 Mbps → remonte progressivement
    assert.ok(s.factors().throughput > dip);
  });

  it('succès/échecs alternés : le taux de succès est bien une EWMA dans [0,1]', () => {
    const { s } = score('normal');
    for (let i = 0; i < 20; i += 1) s.recordSuccess(100_000, 100);
    assert.ok(s.snapshot().successRate <= 1 && s.snapshot().successRate > 0.9);
  });
});

describe('PeerScore — pénalités, UNRELIABLE, cooldown, réhabilitation (§14-15)', () => {
  it('3 échecs durs consécutifs → UNRELIABLE (cooldown), score à 0', () => {
    const { s } = score('normal', undefined, { unreliableAfter: 3, cooldownMs: 600_000 });
    s.recordFailure('timeout'); s.recordFailure('timeout');
    assert.equal(s.reliable, true); // pas encore
    s.recordFailure('timeout');
    assert.equal(s.reliable, false); // 3ᵉ → condamné
    assert.equal(s.cooling, true);
    assert.equal(s.score(), 0);
  });

  it('échec souple (unavailable/overloaded) ne condamne JAMAIS, même ×10', () => {
    const { s } = score('normal', undefined, { unreliableAfter: 3 });
    for (let i = 0; i < 10; i += 1) s.recordFailure('unavailable');
    for (let i = 0; i < 10; i += 1) s.recordFailure('overloaded');
    assert.equal(s.reliable, true);
    assert.equal(s.cooling, false);
  });

  it('hash = 2 échecs durs (pair menteur, §27) : deux fois → UNRELIABLE', () => {
    const { s } = score('normal', undefined, { unreliableAfter: 3 });
    s.recordFailure('hash'); // compte 2
    assert.equal(s.reliable, true);
    s.recordFailure('timeout'); // total 3 durs → condamné
    assert.equal(s.reliable, false);
  });

  it('réhabilitation : après le cooldown, le pair redevient testable', () => {
    const { s, tick } = score('normal', undefined, { unreliableAfter: 3, cooldownMs: 60_000 });
    s.recordFailure('timeout'); s.recordFailure('timeout'); s.recordFailure('timeout');
    assert.equal(s.reliable, false);
    tick(61_000); // cooldown écoulé
    assert.equal(s.reliable, true);
    assert.equal(s.score() > 0, true); // et un succès le relance
  });

  it('rechute après cooldown → cooldown PROLONGÉ (escalade, §15)', () => {
    const { s, tick } = score('normal', undefined, { unreliableAfter: 3, cooldownMs: 60_000, cooldownEscalation: 2 });
    for (let i = 0; i < 3; i += 1) s.recordFailure('timeout'); // 1ʳᵉ condamnation
    tick(61_000);
    assert.equal(s.reliable, true); // le 1ᵉʳ cooldown (60 s) est écoulé
    for (let i = 0; i < 3; i += 1) s.recordFailure('timeout'); // rechute → escaladée
    tick(61_000);
    assert.equal(s.reliable, false); // le 2ᵉ cooldown est STRICTEMENT plus long que 60 s : encore en pause
  });

  it('un succès après condamnation efface le compteur de rechute', () => {
    const { s } = score('normal', undefined, { unreliableAfter: 3, cooldownMs: 60_000 });
    s.recordFailure('timeout'); s.recordFailure('timeout');
    s.recordSuccess(200_000, 200); // le succès rétablit la confiance (§15)
    assert.equal(s.reliable, true);
    s.recordFailure('timeout'); s.recordFailure('timeout'); // ne franchit pas le seuil sans le 3ᵉ
    assert.equal(s.reliable, true);
  });
});

describe('PeerScore — capacité d’upload (§19)', () => {
  it('capacity off → score nul (jamais sélectionné comme seeder)', () => {
    const { s } = score('off');
    assert.equal(s.score(), 0);
    s.recordSuccess(500_000, 100); // même servi avec succès, off reste off au niveau facteur upload
    assert.equal(s.score(), 0);
  });
  it('low bat off, normal bat low (facteur upload monotone)', () => {
    const off = score('off').s; const low = score('low').s; const normal = score('normal').s;
    assert.ok(normal.score() > low.score());
    assert.equal(off.score(), 0);
  });
  it('setCap conserve l’historique (seul le facteur upload bouge)', () => {
    const { s } = score('low');
    s.recordSuccess(300_000, 100);
    const before = s.snapshot().successRate;
    s.setCap('normal');
    assert.equal(s.snapshot().successRate, before); // historique intact
    assert.ok(s.score() > 0);
  });
});

describe('PeerScore — configuration des poids + garde-fous numériques', () => {
  it('poids configurables : ne pondérer que success isole ce facteur', () => {
    const only = { success: 1, throughput: 0, rtt: 0, freshness: 0, upload: 0, stability: 0 };
    const { s } = score('normal', undefined, { weights: only });
    s.recordSuccess(1, 1); // throughput quasi nul mais on s'en fiche (poids 0)
    assert.equal(s.snapshot().reliable, true);
    assert.ok(s.score() > 0.9); // ~success EWMA seule
  });
  it('aucune division par zéro / NaN : poids à 0 → score borni', () => {
    const zero = { success: 0, throughput: 0, rtt: 0, freshness: 0, upload: 0, stability: 0 };
    const { s } = score('normal', undefined, { weights: zero });
    s.recordSuccess(100_000, 100);
    assert.ok(Number.isFinite(s.score()));
    assert.equal(s.score(), 0); // somme des poids nulle → 0, pas NaN
  });
  it('durée 0 (jamais de division par zéro sur le débit)', () => {
    const { s } = score('normal');
    assert.doesNotThrow(() => s.recordSuccess(100_000, 0));
    assert.ok(Number.isFinite(s.score()));
  });
  it('snapshot expose les compteurs agrégés pour STATS_REPORT (§28)', () => {
    const { s } = score('normal');
    s.recordSuccess(1000, 10); s.recordFailure('timeout');
    const c = s.counters();
    assert.equal(c.ok, 1);
    assert.equal(c.fail, 1);
    assert.equal(c.bytes, 1000);
  });
});
