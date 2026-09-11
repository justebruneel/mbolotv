// Port des tests de référence m3u.parser.spec.ts (apps/api, gelé — ADR-0002
// Phase 3) vers l'implémentation Worker src/m3u.js.
// Différences d'API assumées :
//   - le Worker n'a pas de parseM3u string sync : on passe par un
//     ReadableStream (parseM3uStream) — même sémantique ligne à ligne ;
//   - le titre d'une entrée sans tvg-name tombe sur displayName/'Sans titre'
//     (même chaîne de repli que la référence) ;
//   - une playlist vide est rejetée par le Worker (garde d'import).
// Lancer : node --test workers/mbolo-tv-api/test/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isFolderMarker, isVodUrl, parseM3uStream } from '../src/m3u.js';

function streamOf(text) {
  const bytes = new TextEncoder().encode(text);
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(index, index + 60));
      index += 60;
    },
  });
}

async function parseM3u(playlist, options = {}) {
  const channels = [];
  const count = await parseM3uStream(
    streamOf(playlist),
    async (entry) => { channels.push(entry); },
    options.maxBytes ?? 512 * 1024 * 1024,
  );
  return { channels, count };
}

describe('m3u.worker — porté de apps/api (référence gelée)', () => {
  describe('isFolderMarker', () => {
    it('détecte les marqueurs de dossiers', () => {
      assert.equal(isFolderMarker('##### SPORTS #####'), true);
      assert.equal(isFolderMarker('### FRANCE ###'), true);
    });

    it('ignore les titres normaux', () => {
      assert.equal(isFolderMarker('France 24'), false);
      assert.equal(isFolderMarker('BeIn Sports'), false);
    });
  });

  describe('parseM3uStream (équivalent parseM3u)', () => {
    it('parse les chaînes avec group-title', async () => {
      const playlist = [
        '#EXTM3U',
        '#EXTINF:-1 group-title="News",France 24',
        'http://server.com/france24.m3u8',
        '#EXTINF:-1 group-title="Sport",Eurosport',
        'http://server.com/eurosport.m3u8',
      ].join('\n');

      const { channels } = await parseM3u(playlist);
      assert.equal(channels.length, 2);
      assert.equal(channels[0].title, 'France 24');
      assert.equal(channels[0].groupTitle, 'News');
      assert.equal(channels[1].title, 'Eurosport');
      assert.equal(channels[1].groupTitle, 'Sport');
    });

    it('ignore les marqueurs de dossiers (##### X #####)', async () => {
      const playlist = [
        '#EXTM3U',
        '#EXTINF:-1,##### SPORTS #####',
        'http://server.com/sports.m3u8',
        '#EXTINF:-1,France 24',
        'http://server.com/france24.m3u8',
      ].join('\n');

      const { channels } = await parseM3u(playlist);
      assert.equal(channels.length, 1);
      assert.equal(channels[0].title, 'France 24');
    });

    it('ignore les entrées dont l\'URL pointe vers un conteneur .m3u', async () => {
      const playlist = [
        '#EXTM3U',
        '#EXTINF:-1,Collection Sport',
        'http://server.com/sports.m3u',
        '#EXTINF:-1,France 24',
        'http://server.com/france24.m3u8',
      ].join('\n');

      const { channels } = await parseM3u(playlist);
      assert.equal(channels.length, 1);
      assert.equal(channels[0].title, 'France 24');
    });

    it('ignore les titres suspects avec une URL sans extension vidéo', async () => {
      const playlist = [
        '#EXTM3U',
        '#EXTINF:-1,Playlist France',
        'http://server.com/france',
        '#EXTINF:-1,France 24',
        'http://server.com/france24.m3u8',
      ].join('\n');

      const { channels } = await parseM3u(playlist);
      assert.equal(channels.length, 1);
      assert.equal(channels[0].title, 'France 24');
    });

    it('gère les lignes #EXTGRP comme groupe par défaut', async () => {
      const playlist = [
        '#EXTM3U',
        '#EXTGRP:Sport',
        '#EXTINF:-1,France 24',
        'http://server.com/france24.m3u8',
      ].join('\n');

      const { channels } = await parseM3u(playlist);
      assert.equal(channels.length, 1);
      assert.equal(channels[0].groupTitle, 'Sport');
    });

    it('refuse une playlist sans aucune chaîne exploitable (garde Worker, pas dans la référence)', async () => {
      const playlist = ['#EXTM3U', '#EXTINF:-1,France 24', 'not-a-url'].join('\n');
      await assert.rejects(parseM3u(playlist), /aucune chaîne exploitable/);
    });
  });

  describe('isVodUrl', () => {
    it('détecte les fichiers films (jamais des flux live)', () => {
      assert.equal(isVodUrl('http://server.com/film.mp4'), true);
      assert.equal(isVodUrl('http://server.com/film.mkv'), true);
      assert.equal(isVodUrl('http://server.com/film.avi?token=abc'), true);
      assert.equal(isVodUrl('http://server.com/live.m3u8'), false);
      assert.equal(isVodUrl('http://server.com/live.ts'), false);
    });
  });

  describe('limite d\'octets', () => {
    it('refuse un flux qui dépasse la limite', async () => {
      const playlist = '#EXTM3U\n#EXTINF:-1,A\nhttp://server.com/a.m3u8\n';
      await assert.rejects(parseM3u(playlist, { maxBytes: 10 }), /trop volumineuse/i);
    });
  });
});
