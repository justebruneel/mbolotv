import { ConfigService } from '@nestjs/config';
import { PlaylistCache } from './playlist-cache';

describe('PlaylistCache', () => {
  function createCache(): PlaylistCache {
    const config = {
      get: (key: string, fallback: unknown) => ({
        STREAM_PLAYLIST_STALE_TTL_MS: 1000,
        STREAM_PLAYLIST_CACHE_MAX_ENTRIES: 2,
        STREAM_PLAYLIST_CACHE: 'memory',
      } as Record<string, unknown>)[key] ?? fallback,
    } as unknown as ConfigService;
    return new PlaylistCache(config);
  }

  it('partage une playlist par session et alias', async () => {
    const cache = createCache();
    await cache.set('session-a', 'master', '#EXTM3U');
    expect(await cache.get('session-a', 'master')).toBe('#EXTM3U');
    expect(await cache.get('session-b', 'master')).toBeNull();
  });

  it('expire les entrées stale', async () => {
    jest.useFakeTimers();
    try {
      const cache = createCache();
      await cache.set('session-a', 'master', '#EXTM3U');
      jest.advanceTimersByTime(1001);
      expect(await cache.get('session-a', 'master')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('borne le fallback mémoire', async () => {
    const cache = createCache();
    await cache.set('a', 'master', 'a');
    await cache.set('b', 'master', 'b');
    await cache.set('c', 'master', 'c');
    expect(await cache.get('a', 'master')).toBeNull();
    expect(await cache.get('c', 'master')).toBe('c');
  });
});
