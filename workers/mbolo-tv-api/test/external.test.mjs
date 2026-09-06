// Tests unitaires de la sérialisation publique des titres externes.
// Lancer : node --test workers/mbolo-tv-api/test/
// Point crucial : un host sans extracteur (vidzy, filmoon…) ne peut PAS être
// exposé en « direct » — /api/x/play le renverrait 400. Le repli iframe est
// donc forcé à la lecture, y compris pour les lignes en base publiées avant
// le repli (colonne mode = 'direct' ou absente).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_HOSTS } from '../src/extractors/index.js';
import { _internal } from '../src/external.js';

const { effectiveSourceMode, serializeSource } = _internal;

describe('effectiveSourceMode — repli iframe', () => {
  it('garde direct pour un host supporté déclaré direct', () => {
    for (const host of SUPPORTED_HOSTS) {
      assert.equal(effectiveSourceMode({ mode: 'direct', host }), 'direct', host);
    }
  });
  it('force iframe pour un host sans extracteur déclaré direct', () => {
    assert.equal(effectiveSourceMode({ mode: 'direct', host: 'vidzy' }), 'iframe');
    assert.equal(effectiveSourceMode({ mode: 'direct', host: 'filmoon' }), 'iframe');
  });
  it('force iframe quand le mode est absent (sélection SQL sans colonne mode)', () => {
    assert.equal(effectiveSourceMode({ host: 'vidzy' }), 'iframe');
    assert.equal(effectiveSourceMode({ mode: null, host: 'mixdrop' }), 'iframe');
  });
  it('respecte iframe explicite même sur host supporté', () => {
    assert.equal(effectiveSourceMode({ mode: 'iframe', host: 'mixdrop' }), 'iframe');
  });
});

describe('serializeSource', () => {
  it('expose iframe + playRef embed pour vidzy stocké direct', () => {
    const out = serializeSource({
      id: 's1', host: 'vidzy', mode: 'direct', versions: ['VF'],
      embedUrl: 'https://vidzy.cc/embed-p731ofuec673.html', finalUrl: null,
    });
    assert.equal(out.mode, 'iframe');
    assert.equal(out.playRef, 'https://vidzy.cc/embed-p731ofuec673.html');
  });
  it('expose direct pour mixdrop stocké direct', () => {
    const out = serializeSource({
      id: 's2', host: 'mixdrop', mode: 'direct', versions: [],
      embedUrl: 'https://mixdrop.co/e/abc', finalUrl: 'https://mixdrop.co/f/abc',
    });
    assert.equal(out.mode, 'direct');
    assert.equal(out.playRef, 'https://mixdrop.co/f/abc');
  });
});
