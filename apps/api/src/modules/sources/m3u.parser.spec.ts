import { isFolderMarker, parseM3u } from './m3u.parser';

describe('m3u.parser', () => {
  describe('isFolderMarker', () => {
    it('détecte les marqueurs de dossiers', () => {
      expect(isFolderMarker('##### SPORTS #####')).toBe(true);
      expect(isFolderMarker('### FRANCE ###')).toBe(true);
    });

    it('ignore les titres normaux', () => {
      expect(isFolderMarker('France 24')).toBe(false);
      expect(isFolderMarker('BeIn Sports')).toBe(false);
    });
  });

  describe('parseM3u', () => {
    it('parse les chaînes avec group-title', () => {
      const playlist = [
        '#EXTM3U',
        '#EXTINF:-1 group-title="News",France 24',
        'http://server.com/france24.m3u8',
        '#EXTINF:-1 group-title="Sport",Eurosport',
        'http://server.com/eurosport.m3u8',
      ].join('\n');

      const channels = parseM3u(playlist);
      expect(channels).toHaveLength(2);
      expect(channels[0]).toMatchObject({ title: 'France 24', groupTitle: 'News' });
      expect(channels[1]).toMatchObject({ title: 'Eurosport', groupTitle: 'Sport' });
    });

    it('ignore les marqueurs de dossiers (##### X #####)', () => {
      const playlist = [
        '#EXTM3U',
        '#EXTINF:-1,##### SPORTS #####',
        'http://server.com/sports.m3u8',
        '#EXTINF:-1,France 24',
        'http://server.com/france24.m3u8',
      ].join('\n');

      const channels = parseM3u(playlist);
      expect(channels).toHaveLength(1);
      expect(channels[0].title).toBe('France 24');
    });

    it('ignore les entrées dont l’URL pointe vers un conteneur .m3u', () => {
      const playlist = [
        '#EXTM3U',
        '#EXTINF:-1,Collection Sport',
        'http://server.com/sports.m3u',
        '#EXTINF:-1,France 24',
        'http://server.com/france24.m3u8',
      ].join('\n');

      const channels = parseM3u(playlist);
      expect(channels).toHaveLength(1);
      expect(channels[0].title).toBe('France 24');
    });

    it('ignore les titres suspects avec une URL sans extension vidéo', () => {
      const playlist = [
        '#EXTM3U',
        '#EXTINF:-1,Playlist France',
        'http://server.com/france',
        '#EXTINF:-1,France 24',
        'http://server.com/france24.m3u8',
      ].join('\n');

      const channels = parseM3u(playlist);
      expect(channels).toHaveLength(1);
      expect(channels[0].title).toBe('France 24');
    });

    it('gère les lignes #EXTGRP comme groupe par défaut', () => {
      const playlist = [
        '#EXTM3U',
        '#EXTGRP:Sport',
        '#EXTINF:-1,France 24',
        'http://server.com/france24.m3u8',
      ].join('\n');

      const channels = parseM3u(playlist);
      expect(channels).toHaveLength(1);
      expect(channels[0].groupTitle).toBe('Sport');
    });

    it('ignore les lignes sans URL valide', () => {
      const playlist = [
        '#EXTM3U',
        '#EXTINF:-1,France 24',
        'not-a-url',
      ].join('\n');

      expect(parseM3u(playlist)).toHaveLength(0);
    });
  });
});
