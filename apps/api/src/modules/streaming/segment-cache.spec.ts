import { SegmentCache } from './segment-cache';

describe('SegmentCache', () => {
  it('sert une entrée dans le TTL et la met à jour', () => {
    const cache = new SegmentCache(1024, 45_000);
    cache.set('k', Buffer.from('abc'), 'video/mp2t');
    expect(cache.get('k')).toEqual({ buffer: Buffer.from('abc'), contentType: 'video/mp2t' });

    cache.set('k', Buffer.from('def'), 'video/mp2t');
    expect(cache.get('k')?.buffer.toString()).toBe('def');
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(3);
  });

  it('expire après le TTL', () => {
    jest.useFakeTimers();
    try {
      const cache = new SegmentCache(1024, 45_000);
      cache.set('k', Buffer.from('abc'), null);
      jest.advanceTimersByTime(45_001);
      expect(cache.get('k')).toBeNull();
      expect(cache.size).toBe(0);
      expect(cache.bytes).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('respecte le plafond global en évincant les entrées les plus anciennes', () => {
    const cache = new SegmentCache(100, 60_000);
    cache.set('a', Buffer.alloc(40), null);
    cache.set('b', Buffer.alloc(40), null);
    cache.set('c', Buffer.alloc(40), null);
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).not.toBeNull();
    expect(cache.get('c')).not.toBeNull();
    expect(cache.bytes).toBe(80);
  });

  it('refuse une entrée plus grosse que le plafond global', () => {
    const cache = new SegmentCache(100, 60_000);
    cache.set('a', Buffer.alloc(150), null);
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeNull();
  });
});