// Extensions télémétrie phase 2 : up/down, first-frame/manifest/segment,
// journal borné. Lancer : node --import tsx --test <ce fichier>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlayerTelemetry, appendBounded, MAX_PLAYER_LOG_ENTRIES,
} from '../src/Player/telemetry.ts';

describe('telemetry — sens des changements (up/down)', () => {
  it('montée et descente comptées séparément, inconnues = changement simple', () => {
    const t = createPlayerTelemetry();
    t.recordQuality('480p', 480);
    t.recordQuality('720p', 720);
    t.recordQuality('480p', 480);
    t.recordQuality('480p', 480); // identique : rien
    t.recordQuality('auto', null); // hauteur inconnue : changement, pas de sens
    const s = t.snapshot();
    assert.equal(s.qualityChanges, 3);
    assert.equal(s.upSwitchCount, 1);
    assert.equal(s.downSwitchCount, 1);
  });
  it('oscillation détectable : up/down alternés', () => {
    const t = createPlayerTelemetry();
    for (const [label, h] of [['480p', 480], ['720p', 720], ['480p', 480], ['720p', 720]]) {
      t.recordQuality(label, h);
    }
    const s = t.snapshot();
    assert.equal(s.upSwitchCount, 2);
    assert.equal(s.downSwitchCount, 1);
  });
});

describe('telemetry — first-frame / manifest / segment (mesures ou null)', () => {
  it('first-wins, null par défaut, reset oublie', () => {
    const t = createPlayerTelemetry();
    assert.equal(t.snapshot().firstFrameMs, null);
    assert.equal(t.snapshot().manifestMs, null);
    assert.equal(t.snapshot().firstSegmentMs, null);
    t.recordManifest(300);
    t.recordFirstSegment(900);
    t.recordFirstFrame(1200);
    t.recordManifest(100); // ignoré : premier gagne
    t.recordFirstFrame(-5); // invalide : ignoré
    const s = t.snapshot();
    assert.equal(s.manifestMs, 300);
    assert.equal(s.firstSegmentMs, 900);
    assert.equal(s.firstFrameMs, 1200);
    t.reset();
    assert.equal(t.snapshot().firstFrameMs, null);
  });
});

describe('telemetry — contexte des switches (diagnostic ABR)', () => {
  it('first/last switch + délai du premier up-switch', () => {
    const t = createPlayerTelemetry();
    assert.equal(t.snapshot().firstSwitch, null);
    assert.equal(t.snapshot().timeToFirstUpSwitchMs, null);
    t.recordQuality('480p', 480, { bitrate: 800000, bufferAheadSec: 3, throughputMbps: 2, atMs: 8000 });
    t.recordQuality('720p', 720, { bitrate: 2500000, bufferAheadSec: 12, throughputMbps: 6, atMs: 20000 });
    t.recordQuality('480p', 480, { bitrate: 800000, bufferAheadSec: 4, throughputMbps: 3, atMs: 40000 });
    const s = t.snapshot();
    assert.equal(s.firstSwitch.label, '720p');
    assert.equal(s.firstSwitch.bufferAheadSec, 12);
    assert.equal(s.firstSwitch.throughputMbps, 6);
    assert.equal(s.lastSwitch.label, '480p');
    assert.equal(s.lastSwitch.atMs, 40000);
    assert.equal(s.timeToFirstUpSwitchMs, 20000);
    t.reset();
    assert.equal(t.snapshot().firstSwitch, null);
    assert.equal(t.snapshot().timeToFirstUpSwitchMs, null);
  });
  it('sans contexte : échantillons partiels mais jamais d’exception', () => {
    const t = createPlayerTelemetry();
    t.recordQuality('480p', 480);
    t.recordQuality('720p', 720);
    const s = t.snapshot();
    assert.equal(s.firstSwitch.label, '720p');
    assert.equal(s.firstSwitch.bufferAheadSec, null);
    assert.equal(s.timeToFirstUpSwitchMs, null); // pas de atMs → pas de délai
  });
});

describe('telemetry — variante fast-start (benchmark §4)', () => {
  it('null par défaut, set/reset, valeur invalide refusée', () => {
    const t = createPlayerTelemetry();
    assert.equal(t.snapshot().fastStartVariant, null);
    t.setFastStartVariant('progressive');
    assert.equal(t.snapshot().fastStartVariant, 'progressive');
    t.setFastStartVariant('baseline');
    assert.equal(t.snapshot().fastStartVariant, 'baseline');
    t.setFastStartVariant('n-importe-quoi');
    assert.equal(t.snapshot().fastStartVariant, 'baseline'); // refusé : inchangé
    t.setFastStartVariant(null);
    assert.equal(t.snapshot().fastStartVariant, null);
    t.setFastStartVariant('baseline');
    t.reset();
    assert.equal(t.snapshot().fastStartVariant, null);
  });
});

describe('telemetry — preload adaptatif (phase 4)', () => {
  it('défauts NORMAL, transitions comptées, max observé, AGGRESSIVE compté', () => {
    const t = createPlayerTelemetry();
    assert.equal(t.snapshot().preloadProfile, 'NORMAL');
    assert.equal(t.snapshot().preloadTransitions, 0);
    t.recordPreload('PROTECT', 75, 60, 'soft-hold', { bufferAheadSec: 10, throughputMbps: 2, bitrate: 1 });
    t.recordPreload('AGGRESSIVE', 90, 60, 'hard-hold-escalate', { bufferAheadSec: 4, throughputMbps: 0.8, bitrate: 1.2 });
    const s = t.snapshot();
    assert.equal(s.preloadProfile, 'AGGRESSIVE');
    assert.equal(s.preloadTargetSec, 90);
    assert.equal(s.preloadBaselineSec, 60);
    assert.equal(s.preloadTransitions, 2);
    assert.equal(s.preloadMaxObservedSec, 90);
    assert.equal(s.preloadAggressiveCount, 1);
    assert.equal(s.lastPreloadTransition.reason, 'hard-hold-escalate');
    assert.equal(s.lastPreloadTransition.bufferAheadSec, 4);
    t.reset();
    assert.equal(t.snapshot().preloadProfile, 'NORMAL');
    assert.equal(t.snapshot().preloadTransitions, 0);
  });
  it('valeurs invalides assainies, jamais de throw', () => {
    const t = createPlayerTelemetry();
    t.recordPreload('N-IMPORTE-QUOI', NaN, -5, null, {});
    const s = t.snapshot();
    assert.equal(s.preloadProfile, 'NORMAL');
    assert.ok(Number.isFinite(s.preloadTargetSec));
  });
});

describe('appendBounded — journal 500 max (§10)', () => {
  it('501 événements → 500 conservés, les plus récents', () => {
    const log = [];
    for (let i = 0; i < 501; i += 1) appendBounded(log, { ts: i }, MAX_PLAYER_LOG_ENTRIES);
    assert.equal(log.length, 500);
    assert.equal(log[0].ts, 1);
    assert.equal(log[499].ts, 500);
  });
  it('borne personnalisée + jamais de throw', () => {
    const log = [{ ts: 0 }];
    appendBounded(log, { ts: 1 }, 1);
    assert.deepEqual(log.map((e) => e.ts), [1]);
    assert.doesNotThrow(() => appendBounded(null, { ts: 2 }, 10));
  });
});
