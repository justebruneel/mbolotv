// Transition fast-start (logique pure) : démarrage au plus bas, palier
// médian sur niveaux RÉELS, libération conditionnée — jamais de 360p/480p
// supposé, repli baseline automatique.
// Lancer : node --import tsx --test packages/ui/test/player-fast-start.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  lowestLevelIndex, midLevelIndex, shouldReleaseFastStart, resolveOnlineAction,
} from '../src/Player/fastStart.ts';

const LEVELS = [
  { index: 0, height: 240 }, { index: 1, height: 360 }, { index: 2, height: 480 },
  { index: 3, height: 720 }, { index: 4, height: 1080 },
];
// Ordre fournisseur quelconque : les index ne sont PAS triés par hauteur.
const SHUFFLED = [
  { index: 4, height: 1080 }, { index: 0, height: 240 }, { index: 3, height: 720 },
  { index: 1, height: 360 }, { index: 2, height: 480 },
];

describe('fast-start — niveau bas initial', () => {
  it('le plus bas par hauteur, quel que soit l’ordre fournisseur', () => {
    assert.equal(lowestLevelIndex(LEVELS), 0);
    assert.equal(lowestLevelIndex(SHUFFLED), 0);
    assert.equal(lowestLevelIndex([]), -1);
    assert.equal(lowestLevelIndex(null), -1);
  });
});

describe('fast-start — palier médian sur niveaux réels', () => {
  it('5 niveaux sans cap : médian 480p', () => {
    assert.equal(midLevelIndex(LEVELS, 0, -1), 2);
    assert.equal(midLevelIndex(SHUFFLED, 0, -1), 2);
  });
  it('cap contraint : médian dans la plage autorisée', () => {
    assert.equal(midLevelIndex(LEVELS, 0, 3), 1); // [240,360,480,720] → 360p
    assert.equal(midLevelIndex(LEVELS, 0, 1), null); // [240,360] : pas de milieu
  });
  it('mono-variante / cap au plus bas : null → libération directe (baseline)', () => {
    assert.equal(midLevelIndex([{ index: 0, height: 480 }], 0, -1), null);
    assert.equal(midLevelIndex(LEVELS, 0, 0), null);
    assert.equal(midLevelIndex([], 0, -1), null);
    assert.equal(midLevelIndex(LEVELS, -1, -1), null);
  });
  it('2 niveaux : pas de milieu utile', () => {
    assert.equal(midLevelIndex([{ index: 0, height: 360 }, { index: 1, height: 720 }], 0, -1), null);
  });
});

describe('fast-start — libération conditionnée', () => {
  it('rebuffer → prolonger, jamais libérer dessus', () => {
    assert.deepEqual(shouldReleaseFastStart({ rebuffered: true, bufferAheadSec: 99, startupTargetSec: 2 }), { release: false, reason: 'rebuffer' });
  });
  it('confortable (≥2× cible) → libérer', () => {
    assert.deepEqual(shouldReleaseFastStart({ rebuffered: false, bufferAheadSec: 4, startupTargetSec: 2 }), { release: true, reason: 'stable' });
  });
  it('non confortable → prolonger (pas de montée aveugle)', () => {
    assert.deepEqual(shouldReleaseFastStart({ rebuffered: false, bufferAheadSec: 3.9, startupTargetSec: 2 }), { release: false, reason: 'buffer' });
    assert.deepEqual(shouldReleaseFastStart({ rebuffered: false, bufferAheadSec: 0.5, startupTargetSec: 2 }), { release: false, reason: 'buffer' });
  });
  it('mesure absente → libérer (on ne colle jamais au niveau bas par défaut)', () => {
    assert.deepEqual(shouldReleaseFastStart({ rebuffered: false, bufferAheadSec: NaN, startupTargetSec: 2 }), { release: true, reason: 'no-measure' });
    assert.deepEqual(shouldReleaseFastStart({ rebuffered: false, bufferAheadSec: 5, startupTargetSec: 0 }), { release: true, reason: 'no-measure' });
  });
});

describe('online — table de décision (pas de destroy, pas de perte position)', () => {
  it('erreur → retry, pause douce → startLoad, sain → none', () => {
    assert.equal(resolveOnlineAction(true, false), 'retry');
    assert.equal(resolveOnlineAction(true, true), 'retry'); // l’erreur prime
    assert.equal(resolveOnlineAction(false, true), 'startLoad');
    assert.equal(resolveOnlineAction(false, false), 'none');
  });
});
