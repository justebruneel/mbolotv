import { BadGatewayException } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamProxy } from './stream-proxy';

// La protection SSRF refuse 127.0.0.1 : on simule une résolution DNS publique
// pour pouvoir tester le comportement réseau contre un serveur local.
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => [{ address: '8.8.8.8', family: 4 }]),
}));

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

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

  it('ne crashe pas quand le fournisseur envoie un corps puis coupe la connexion (undici #5360)', async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': '100000000' });
      res.write(Buffer.alloc(256 * 1024, 0x61), () => res.socket?.destroy());
    });
    const baseUrl = await listen(server);
    try {
      const proxy = new StreamProxy();
      const response = await proxy.fetch(`${baseUrl}/seg.ts`, {
        allowedHostnames: new Set(['127.0.0.1']),
      });
      const stream = response.stream;
      let received = 0;
      try {
        for await (const chunk of stream) received += (chunk as Buffer).length;
      } catch {
        // Fermeture prématurée attendue — l'essentiel : pas de crash process.
      }
      expect(received).toBeGreaterThan(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('valide un hôte une seule fois (cache SSRF par hostname)', async () => {
    const dns = jest.requireMock('node:dns/promises') as { lookup: jest.Mock };
    dns.lookup.mockClear();

    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.end(Buffer.from('abc'));
    });
    const baseUrl = await listen(server);
    try {
      const proxy = new StreamProxy();
      for (let i = 0; i < 3; i += 1) {
        const response = await proxy.fetch(`${baseUrl}/seg-${i}.ts`, {
          allowedHostnames: new Set(['127.0.0.1']),
        });
        const chunks: Buffer[] = [];
        for await (const chunk of response.stream) chunks.push(chunk as Buffer);
        expect(Buffer.concat(chunks).toString()).toBe('abc');
      }
      expect(dns.lookup).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
