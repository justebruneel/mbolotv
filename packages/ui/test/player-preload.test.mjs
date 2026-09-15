// Contrôleur de préchargement adaptatif LIVE — logique pure, déterministe.
// Matrice : baseline, limites, réseau, appareil, rebuffer, hystérésis,
// saveData, offline, invisible, fast-start, cap hls, transitions, manquants.
// Lancer : node --import tsx --test packages/ui/test/player-preload.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decidePreloadTarget,
  PRELOAD_HARD_MAX_SEC,
} from '../src/Player/preloadController.ts';

const BASE = {
  baselineSec: 60,
  currentProfile: 'NORMAL',
  currentTargetSec: 60,
  bufferAheadSec: 45,
  throughputMbps: 8,
  currentBitrateMbps: 1.2,
  recentRebufferCount: 0,
  networkType: 'wifi',
  deviceMemoryGB: null,
  hardwareConcurrency: 8,
  saveData: false,
  visible: true,
  online: true,
  fastStart: false,
  live: true,
};

describe('preload — A. Baseline (NORMAL conserve 40/50/60)', () => {
  for (const baseline of [40, 50, 60]) {
    it(`baseline ${baseline}s + conditions normales → NORMAL ${baseline}s`, () => {
      const d = decidePreloadTarget({ ...BASE, baselineSec: baseline, currentTargetSec: baseline });
      assert.equal(d.profile, 'NORMAL');
      assert.equal(d.targetBufferSec, baseline);
      assert.equal(d.changed, false);
    });
  }
  it('jamais inférieur à baseline', () => {
    const d = decidePreloadTarget({ ...BASE, baselineSec: 50, currentTargetSec: 50, bufferAheadSec: 0 });
    assert.ok(d.targetBufferSec >= 50);
  });
});

describe('preload — B. Limites absolues', () => {
  it('jamais > 90, même baseline haute + besoin maximal', () => {
    const d = decidePreloadTarget({
      ...BASE, baselineSec: 85, currentTargetSec: 85, currentProfile: 'PROTECT',
      bufferAheadSec: 1, throughputMbps: 0.5, currentBitrateMbps: 3,
      recentRebufferCount: 5,
    });
    assert.ok(d.targetBufferSec <= PRELOAD_HARD_MAX_SEC);
    assert.ok(d.targetBufferSec <= 90);
  });
  it('jamais négatif/NaN/Infinity, entrées pourries → repli sûr', () => {
    const d = decidePreloadTarget({
      ...BASE, baselineSec: NaN, bufferAheadSec: Infinity,
      throughputMbps: -3, currentBitrateMbps: NaN, recentRebufferCount: -1,
    });
    assert.ok(Number.isFinite(d.targetBufferSec) && d.targetBufferSec >= 0);
    assert.ok(['NORMAL', 'PROTECT', 'AGGRESSIVE'].includes(d.profile));
  });
});

describe('preload — C/D. Réseau lent vs normal', () => {
  it('débit < bitrate + petit buffer → PROTECT d’abord (pas direct AGGRESSIVE)', () => {
    const d = decidePreloadTarget({
      ...BASE, bufferAheadSec: 6, throughputMbps: 0.8, currentBitrateMbps: 1.2,
    });
    assert.equal(d.profile, 'PROTECT');
    assert.ok(d.targetBufferSec > 60 && d.targetBufferSec <= 90);
  });
  it('débit largement supérieur + buffer sain → NORMAL', () => {
    const d = decidePreloadTarget({ ...BASE, throughputMbps: 12, currentBitrateMbps: 1.2 });
    assert.equal(d.profile, 'NORMAL');
    assert.equal(d.targetBufferSec, 60);
  });
});

describe('preload — E/F. Appareil faible', () => {
  it('faible (2 Go/4 cœurs) + réseau lent → montée progressive (PROTECT d’abord)', () => {
    const d = decidePreloadTarget({
      ...BASE, deviceMemoryGB: 2, hardwareConcurrency: 4,
      networkType: '3g', throughputMbps: 0.9, currentBitrateMbps: 1.2, bufferAheadSec: 8,
    });
    assert.equal(d.profile, 'PROTECT');
  });
  it('faible + réseau rapide et sain → NORMAL (pas d’agressivité inutile)', () => {
    const d = decidePreloadTarget({
      ...BASE, deviceMemoryGB: 2, hardwareConcurrency: 4,
      networkType: 'wifi', throughputMbps: 10, currentBitrateMbps: 1.2, bufferAheadSec: 40,
    });
    assert.equal(d.profile, 'NORMAL');
  });
  it('absence des signaux appareil ≠ appareil faible', () => {
    const d = decidePreloadTarget({ ...BASE, deviceMemoryGB: null, hardwareConcurrency: null });
    assert.equal(d.profile, 'NORMAL');
  });
});

describe('preload — G. Rebuffer (escalade puis retour)', () => {
  it('premier rebuffer → PROTECT', () => {
    const d = decidePreloadTarget({ ...BASE, recentRebufferCount: 1, bufferAheadSec: 20 });
    assert.equal(d.profile, 'PROTECT');
  });
  it('rebuffers répétés → AGGRESSIVE en deux paliers (NORMAL→PROTECT→AGGRESSIVE)', () => {
    const p1 = decidePreloadTarget({ ...BASE, recentRebufferCount: 2 });
    assert.equal(p1.profile, 'PROTECT');
    const p2 = decidePreloadTarget({
      ...BASE, currentProfile: 'PROTECT', currentTargetSec: p1.targetBufferSec, recentRebufferCount: 2,
    });
    assert.equal(p2.profile, 'AGGRESSIVE');
    assert.ok(p2.targetBufferSec > p1.targetBufferSec && p2.targetBufferSec <= 90);
  });
  it('stabilité (buffer ≥ cible) → descente par paliers', () => {
    const up = decidePreloadTarget({
      ...BASE, currentProfile: 'PROTECT', currentTargetSec: 75,
      bufferAheadSec: 80, recentRebufferCount: 0,
    });
    assert.equal(up.profile, 'NORMAL');
    const down = decidePreloadTarget({
      ...BASE, currentProfile: 'AGGRESSIVE', currentTargetSec: 90,
      bufferAheadSec: 95, recentRebufferCount: 0,
    });
    assert.equal(down.profile, 'PROTECT'); // jamais direct vers NORMAL
  });
});

describe('preload — H. Hystérésis (transitions interdites)', () => {
  it('NORMAL + besoin fort → PROTECT, jamais AGGRESSIVE direct', () => {
    const d = decidePreloadTarget({
      ...BASE, bufferAheadSec: 1, throughputMbps: 0.3, currentBitrateMbps: 4, recentRebufferCount: 5,
    });
    assert.equal(d.profile, 'PROTECT');
  });
  it('AGGRESSIVE sans besoin mais buffer < cible → maintien (pas de yo-yo)', () => {
    const d = decidePreloadTarget({
      ...BASE, currentProfile: 'AGGRESSIVE', currentTargetSec: 90,
      bufferAheadSec: 40, recentRebufferCount: 0, throughputMbps: 8, currentBitrateMbps: 1,
    });
    assert.equal(d.profile, 'AGGRESSIVE');
  });
});

describe('preload — I/J/K. Guards (descente immédiate)', () => {
  it('saveData → baseline immédiate même en AGGRESSIVE', () => {
    const d = decidePreloadTarget({ ...BASE, currentProfile: 'AGGRESSIVE', currentTargetSec: 90, saveData: true, recentRebufferCount: 5 });
    assert.equal(d.profile, 'NORMAL');
    assert.equal(d.targetBufferSec, 60);
  });
  it('offline → aucune montée (baseline), même en danger', () => {
    const d = decidePreloadTarget({ ...BASE, online: false, bufferAheadSec: 1, recentRebufferCount: 3 });
    assert.equal(d.profile, 'NORMAL');
    assert.equal(d.targetBufferSec, 60);
  });
  it('invisible → baseline', () => {
    const d = decidePreloadTarget({ ...BASE, currentProfile: 'PROTECT', currentTargetSec: 75, visible: false });
    assert.equal(d.profile, 'NORMAL');
  });
});

describe('preload — L. Fast-start et non-live', () => {
  it('fast-start actif → pas d’agressif (baseline)', () => {
    const d = decidePreloadTarget({ ...BASE, fastStart: true, recentRebufferCount: 3, bufferAheadSec: 1 });
    assert.equal(d.profile, 'NORMAL');
  });
  it('non-live (VOD/TS/natif) → baseline, jamais d’adaptatif', () => {
    const d = decidePreloadTarget({ ...BASE, live: false, recentRebufferCount: 5 });
    assert.equal(d.profile, 'NORMAL');
    assert.equal(d.targetBufferSec, 60);
  });
});

describe('preload — M/N/O. Cap, transitions, manquants', () => {
  it('cible ≤ 90 dans tous les cas de la matrice', () => {
    const cases = [
      { ...BASE, currentProfile: 'AGGRESSIVE', currentTargetSec: 90, recentRebufferCount: 9, bufferAheadSec: 0 },
      { ...BASE, baselineSec: 60, currentProfile: 'PROTECT', currentTargetSec: 75, recentRebufferCount: 4 },
    ];
    for (const c of cases) assert.ok(decidePreloadTarget(c).targetBufferSec <= 90);
  });
  it('décision identique → changed=false (pas d’écriture inutile)', () => {
    const d = decidePreloadTarget({ ...BASE, currentTargetSec: 60 });
    assert.equal(d.changed, false);
    const d2 = decidePreloadTarget({ ...BASE, currentProfile: 'PROTECT', currentTargetSec: 75 });
    assert.equal(d2.changed, false);
  });
  it('changement → changed=true', () => {
    const d = decidePreloadTarget({ ...BASE, recentRebufferCount: 1 });
    assert.equal(d.changed, true);
  });
  it('throughput/device/connection absents → aucun crash, décision prudente', () => {
    const d = decidePreloadTarget({
      ...BASE, throughputMbps: null, currentBitrateMbps: null,
      deviceMemoryGB: undefined, hardwareConcurrency: undefined, networkType: null,
    });
    assert.equal(d.profile, 'NORMAL');
    const d2 = decidePreloadTarget({
      ...BASE, throughputMbps: null, currentBitrateMbps: null, recentRebufferCount: 1,
    });
    assert.equal(d2.profile, 'PROTECT'); // le rebuffer seul suffit
  });
});
