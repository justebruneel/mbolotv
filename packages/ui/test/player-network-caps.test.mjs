// Plafonds ABR purs — MÊME formule que Player (MANIFEST_PARSED + effet Éco).
// Matrice : fast→slow, slow→fast, API absente, niveaux vides.
// Lancer : node --import tsx --test packages/ui/test/player-network-caps.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeLevelCaps } from '../src/Player/telemetry.ts';

// Niveaux type chaîne multi-variantes : index 0=240p … 4=1080p.
const LEVELS = [
  { index: 0, height: 240 }, { index: 1, height: 360 }, { index: 2, height: 480 },
  { index: 3, height: 720 }, { index: 4, height: 1080 },
];

describe('computeLevelCaps — matrice réseau (§4-6)', () => {
  it('Wi-Fi rapide (pas de cap) : baseCap -1, dataCap 480p', () => {
    const c = computeLevelCaps(LEVELS, false, null);
    assert.equal(c.networkCap, -1);
    assert.equal(c.dataCap, 2);
    assert.equal(c.baseCap, -1);
  });
  it('fast → slow : réseau 360p → baseCap suit vers le bas (descente proactive)', () => {
    const before = computeLevelCaps(LEVELS, false, null);
    assert.equal(before.baseCap, -1);
    const after = computeLevelCaps(LEVELS, false, 360);
    assert.equal(after.networkCap, 1);
    assert.equal(after.baseCap, 1);
  });
  it('slow → fast : le plafond remonte (pas de verrouillage bas)', () => {
    const slow = computeLevelCaps(LEVELS, false, 360);
    assert.equal(slow.baseCap, 1);
    const fast = computeLevelCaps(LEVELS, false, null);
    assert.equal(fast.baseCap, -1);
  });
  it('Data Saver : min(réseau, 480p) dans tous les cas', () => {
    assert.equal(computeLevelCaps(LEVELS, true, null).baseCap, 2);
    assert.equal(computeLevelCaps(LEVELS, true, 720).baseCap, 2);
    assert.equal(computeLevelCaps(LEVELS, true, 360).baseCap, 1);
  });
  it('API absente / niveaux vides : repli sûr, jamais d’exception', () => {
    assert.deepEqual(computeLevelCaps([], false, null), { networkCap: -1, dataCap: -1, baseCap: -1 });
    assert.deepEqual(computeLevelCaps(null, true, 360), { networkCap: -1, dataCap: -1, baseCap: -1 });
    assert.doesNotThrow(() => computeLevelCaps(LEVELS, false, undefined));
  });
  it('mono-variante : plafonds cohérents, jamais bloquants', () => {
    const c = computeLevelCaps([{ index: 0, height: 480 }], false, 360);
    assert.equal(c.networkCap, 0);
    assert.equal(c.baseCap, 0);
  });
});
