import { BadGatewayException } from '@nestjs/common';
import { StreamProxy } from './stream-proxy';

describe('StreamProxy', () => {
  it('refuse un hôte en IP privée (protection SSRF)', async () => {
    const proxy = new StreamProxy();
    await expect(
      proxy.fetch('http://127.0.0.1/seg.ts', {
        allowedHostnames: new Set(['127.0.0.1']),
      }),
    ).rejects.toThrow(BadGatewayException);
  });

  it('refuse un hôte hors de la liste autorisée', async () => {
    const proxy = new StreamProxy();
    await expect(
      proxy.fetch('http://cdn.example.com/seg.ts', {
        allowedHostnames: new Set(['provider.example.com']),
      }),
    ).rejects.toThrow(BadGatewayException);
  });
});
