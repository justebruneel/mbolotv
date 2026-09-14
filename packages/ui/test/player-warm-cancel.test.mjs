// Warm manifest : cancel sûr (appelable à tout moment, sans AbortController),
// démontage tuile. warmStream lui-même exige window : non testé en Node
// (couvert par shouldWarm + revue de code : timeout 3 s + dedupe + cancel).
// Lancer : node --import tsx --test <ce fichier>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cancelWarm } from '../src/StreamPreloader/StreamPreloader.ts';

describe('warm — cancel sûr au démontage (§11)', () => {
  it('cancelWarm sans warm en cours : silencieux', () => {
    assert.doesNotThrow(() => cancelWarm());
    assert.doesNotThrow(() => cancelWarm());
  });
  it('cancelWarm répété : idempotent', () => {
    cancelWarm();
    assert.doesNotThrow(() => cancelWarm());
  });
});
