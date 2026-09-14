// Niveaux de buffer CRITICAL/LOW/NORMAL/COMFORTABLE — seuils relatifs au
// critique, jamais d'exception, bornes incluses documentées.
// Lancer : node --import tsx --test packages/ui/test/player-buffer-levels.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bufferLevel } from '../src/Player/telemetry.ts';

describe('bufferLevel — politique §4', () => {
  it('seuils relatifs au critique (C=12s)', () => {
    assert.equal(bufferLevel(0, 12), 'CRITICAL');
    assert.equal(bufferLevel(11.9, 12), 'CRITICAL');
    assert.equal(bufferLevel(12, 12), 'LOW');
    assert.equal(bufferLevel(17.9, 12), 'LOW');
    assert.equal(bufferLevel(18, 12), 'NORMAL');
    assert.equal(bufferLevel(23.9, 12), 'NORMAL');
    assert.equal(bufferLevel(24, 12), 'COMFORTABLE');
    assert.equal(bufferLevel(120, 12), 'COMFORTABLE');
  });
  it('seuil invalide : jamais d’exception, repli sain', () => {
    assert.equal(bufferLevel(0, 0), 'CRITICAL');
    assert.equal(bufferLevel(5, 0), 'NORMAL');
    assert.equal(bufferLevel(5, -3), 'NORMAL');
    assert.equal(bufferLevel(NaN, 12), 'CRITICAL');
    assert.equal(bufferLevel(-5, 12), 'CRITICAL');
  });
});
