// Façade de télémétrie Player — agrégation pure, no-throw, aucun pilotage.
// Lancer : node --import tsx --test packages/ui/test/player-telemetry.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerTelemetry } from '../src/Player/telemetry.ts';

describe('telemetry — démarrage et rebuffers', () => {
  it('startup enregistré une fois (premier appel gagne), succès/échec', () => {
    const t = createPlayerTelemetry();
    t.recordStartup(1234, true);
    t.recordStartup(9999, false);
    const s = t.snapshot();
    assert.equal(s.startupMs, 1234);
    assert.equal(s.startupSuccess, true);
  });
  it('rebuffer : compte + durée mesurée, pas de double-start', () => {
    let now = 1000;
    const t = createPlayerTelemetry(() => now);
    t.rebufferStart();
    t.rebufferStart(); // spurious : ignoré
    now = 2500;
    t.rebufferEnd();
    t.rebufferEnd(); // spurious : ignoré
    const s = t.snapshot();
    assert.equal(s.rebufferCount, 1);
    assert.equal(s.rebufferDurationMs, 1500);
  });
  it('reset repart de zéro', () => {
    const t = createPlayerTelemetry();
    t.recordStartup(100, true);
    t.rebufferStart();
    t.recordError('networkError');
    t.reset();
    const s = t.snapshot();
    assert.equal(s.startupMs, null);
    assert.equal(s.rebufferCount, 0);
    assert.deepEqual(s.errors, []);
  });
});

describe('telemetry — qualité, sources, erreurs bornées', () => {
  it('la qualité initiale ne compte pas comme changement', () => {
    const t = createPlayerTelemetry();
    t.recordQuality('480p');
    t.recordQuality('480p');
    t.recordQuality('720p');
    const s = t.snapshot();
    assert.equal(s.quality, '720p');
    assert.equal(s.qualityChanges, 1);
  });
  it('erreurs comptées par type, plafonnées, jamais d’exception', () => {
    const t = createPlayerTelemetry();
    t.recordError('networkError');
    t.recordError('networkError');
    t.recordError(null);
    for (let i = 0; i < 30; i += 1) t.recordError(`type-${i}`);
    const s = t.snapshot();
    const net = s.errors.find((e) => e.type === 'networkError');
    assert.equal(net.count, 2);
    assert.ok(s.errors.length <= 12);
    assert.doesNotThrow(() => t.recordError(undefined));
  });
  it('sourceChanges + fallbacks + networkType', () => {
    const t = createPlayerTelemetry();
    t.recordSourceChange();
    t.recordSourceChange();
    t.recordFallback();
    t.setNetworkType('4g');
    const s = t.snapshot();
    assert.equal(s.sourceChanges, 2);
    assert.equal(s.fallbacks, 1);
    assert.equal(s.networkType, '4g');
  });
});

describe('telemetry — échantillon mesh (lecture seule)', () => {
  it('offload et peerHitRate calculés, 0 si vide, detach → null', () => {
    const t = createPlayerTelemetry();
    assert.equal(t.snapshot().mesh, null);
    t.attachMeshReader(() => ({ peerHits: 3, originHits: 7, peerBytes: 3000, originBytes: 7000 }));
    const s = t.snapshot();
    assert.equal(s.mesh.offload, 0.3);
    assert.equal(s.mesh.peerHitRate, 0.3);
    t.attachMeshReader(null);
    assert.equal(t.snapshot().mesh, null);
  });
  it('reader qui throw → mesh null, snapshot intact', () => {
    const t = createPlayerTelemetry();
    t.attachMeshReader(() => { throw new Error('x'); });
    assert.equal(t.snapshot().mesh, null);
  });
});
