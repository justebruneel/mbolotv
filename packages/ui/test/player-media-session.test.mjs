// MediaSession — construction pure des métadonnées + attaches gardées.
// Lancer : node --import tsx --test packages/ui/test/player-media-session.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaMetadata, updateMediaSession, clearMediaSession } from '../src/Player/mediaSession.ts';

describe('mediaSession — métadonnées (pur, testable)', () => {
  it('titre/artiste/album conservés, bornés', () => {
    const m = buildMediaMetadata({ title: 'Chaîne Info', artist: 'Mbolo', album: 'Direct' });
    assert.equal(m.title, 'Chaîne Info');
    assert.equal(m.artist, 'Mbolo');
    assert.equal(m.album, 'Direct');
    assert.deepEqual(m.artwork, []);
  });
  it('artwork https uniquement — jamais d’URL inventée', () => {
    assert.deepEqual(buildMediaMetadata({ title: 'x', artist: 'y', album: 'z' }).artwork, []);
    assert.deepEqual(buildMediaMetadata({ title: 'x', artist: 'y', album: 'z', artworkUrl: 'ftp://evil/a.png' }).artwork, []);
    const m = buildMediaMetadata({ title: 'x', artist: 'y', album: 'z', artworkUrl: 'https://cdn/a.png' });
    assert.equal(m.artwork[0].src, 'https://cdn/a.png');
  });
  it('défauts sains sur entrée vide', () => {
    const m = buildMediaMetadata({ title: '', artist: '', album: '' });
    assert.equal(m.title, 'Mbolo TV');
    assert.equal(m.artist, 'Mbolo');
  });
});

describe('mediaSession — attaches (Node = indisponible, silencieux)', () => {
  it('sans navigator.mediaSession : false, jamais de throw', () => {
    assert.equal(updateMediaSession({ title: 'x', artist: 'y', album: 'z' }, 'playing', {}), false);
    assert.doesNotThrow(() => clearMediaSession());
  });
});
