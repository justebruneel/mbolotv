// Gardes du préchauffage manifest — jamais de flux infini, jamais en
// économie de données / 2G / arrière-plan.
// Lancer : node --import tsx --test packages/ui/test/player-warm-guards.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldWarm } from '../src/StreamPreloader/StreamPreloader.ts';

const OK = { saveData: false, effectiveType: '4g', visible: true };

describe('shouldWarm — préchauffage restreint (§13/§22)', () => {
  it('manifest HLS en bonnes conditions : oui', () => {
    assert.equal(shouldWarm('https://proxy/?url=x&x-sig=y/playlist.m3u8', OK), true);
  });
  it('jamais de flux TS brut (téléchargement infini) ni fichier opaque', () => {
    assert.equal(shouldWarm('https://relais/stream.ts', OK), false);
    assert.equal(shouldWarm('https://cdn/film.mp4', OK), false);
    assert.equal(shouldWarm('', OK), false);
  });
  it('jamais en économie de données, 2G ou arrière-plan', () => {
    const url = 'https://proxy/live.m3u8';
    assert.equal(shouldWarm(url, { ...OK, saveData: true }), false);
    assert.equal(shouldWarm(url, { ...OK, visible: false }), false);
    assert.equal(shouldWarm(url, { ...OK, effectiveType: '2g' }), false);
    assert.equal(shouldWarm(url, { ...OK, effectiveType: 'slow-2g' }), false);
    assert.equal(shouldWarm(url, { ...OK, effectiveType: '3g' }), true);
    assert.equal(shouldWarm(url, { ...OK, effectiveType: null }), true);
  });
});
