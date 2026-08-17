import { BadRequestException } from '@nestjs/common';
import { assertSafeUrl } from './safe-fetcher';

// DNS réel : ces tests vérifient la protection SSRF d'assertSafeUrl.
describe('assertSafeUrl (SSRF)', () => {
  it('rejette une URL vers une IP privée littérale', async () => {
    await expect(assertSafeUrl('http://127.0.0.1/secret')).rejects.toThrow(BadRequestException);
    await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejette une URL vers une IP privée résolue par DNS', async () => {
    await expect(assertSafeUrl('http://localhost:4000/')).rejects.toThrow(BadRequestException);
  });

  it('rejette les protocoles non http(s)', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow(BadRequestException);
    await expect(assertSafeUrl('ftp://example.com/x')).rejects.toThrow(BadRequestException);
  });

  it('accepte une URL publique', async () => {
    const url = await assertSafeUrl('https://example.com/playlist.m3u8');
    expect(url.hostname).toBe('example.com');
  });
});