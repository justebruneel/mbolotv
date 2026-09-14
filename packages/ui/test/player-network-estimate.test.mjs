// Estimation EWMA du débit lecteur — mesures réelles uniquement, jamais de
// sonde, jamais de NaN, distincte du score MeshStream.
// Lancer : node --import tsx --test packages/ui/test/player-network-estimate.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkEstimate } from '../src/Player/telemetry.ts';

describe('network estimate — débit réel EWMA (§6)', () => {
  it('null sans mesure, puis Mbps = octets*1000/ms*8/1e6', () => {
    const e = createNetworkEstimate();
    assert.equal(e.throughputMbps(), null);
    e.observe(125_000, 1000); // 1 Mbps
    assert.ok(Math.abs(e.throughputMbps() - 1) < 1e-9);
    assert.equal(e.samples(), 1);
  });
  it('mesures invalides ignorées (0, négatif, NaN) — jamais de NaN propagé', () => {
    const e = createNetworkEstimate();
    e.observe(0, 100);
    e.observe(1000, 0);
    e.observe(-5, 100);
    e.observe(1000, -1);
    e.observe(NaN, NaN);
    assert.equal(e.throughputMbps(), null);
    assert.equal(e.samples(), 0);
  });
  it('EWMA α=0.3 : converge sans suivre le dernier pic', () => {
    const e = createNetworkEstimate(0.3);
    e.observe(1_000_000, 1000); // 8 Mbps
    const afterFirst = e.throughputMbps();
    e.observe(125_000, 1000); // 1 Mbps
    const afterDip = e.throughputMbps();
    // 0.3*1 + 0.7*8 = 5.9 Mbps — entre les deux, plus proche de l'historique.
    assert.ok(Math.abs(afterDip - 5.9) < 1e-9, `reçu ${afterDip}`);
    assert.ok(afterDip < afterFirst && afterDip > 1);
  });
  it('reset oublie tout', () => {
    const e = createNetworkEstimate();
    e.observe(1_000_000, 1000);
    e.reset();
    assert.equal(e.throughputMbps(), null);
    assert.equal(e.samples(), 0);
  });
});
