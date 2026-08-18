import { BadRequestException } from '@nestjs/common';
import { assertSafeUrl, SafeFetcher } from './safe-fetcher';

describe('safe-fetcher provider failures', () => {
  it('turns DNS failures into a controlled validation error', async () => {
    await expect(assertSafeUrl('http://[5.63.50.top]/playlist.m3u')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns a controlled error instead of throwing on an unknown provider', async () => {
    const result = await new SafeFetcher().fetch('http://provider-that-does-not-exist.invalid/playlist.m3u8');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
