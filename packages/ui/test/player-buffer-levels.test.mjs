// Niveaux de buffer CRITICAL/LOW/NORMAL/COMFORTABLE — seuils relatifs au
// critique, jamais d'exception, bornes incluses documentées.
// Lancer : node --import tsx --test packages/ui/test/player-buffer-levels.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bufferLevel, stallResumeTarget } from '../src/Player/telemetry.ts';

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

describe('stallResumeTarget — reprise à ~1.5× segment, bornée', () => {
  it('segments courts : base inchangée (3 s)', () => {
    assert.equal(stallResumeTarget(2), 3);
    assert.equal(stallResumeTarget(0), 3);
    assert.equal(stallResumeTarget(-1), 3);
  });
  it('segments longs : ~1.5×, borné à 8 s', () => {
    assert.equal(stallResumeTarget(6), 8); // 9 → borné 8
    assert.equal(stallResumeTarget(4), 6);
    assert.equal(stallResumeTarget(10), 8);
  });
  it('bornes et invalides : jamais d’exception, jamais sous la base', () => {
    assert.equal(stallResumeTarget(NaN), 3);
    assert.equal(stallResumeTarget(Infinity), 3);
    assert.ok(stallResumeTarget(6, 3, 8) >= 3);
    assert.equal(stallResumeTarget(2, 0, -1), 3); // bornes invalides → défauts
  });
});
