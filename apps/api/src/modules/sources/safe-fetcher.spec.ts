import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SafeFetcher, isPrivateIp } from './safe-fetcher';

// La protection SSRF refuse 127.0.0.1 : on simule une résolution DNS publique
// pour pouvoir tester le comportement réseau contre un serveur local.
// (Les tests SSRF de assertSafeUrl vivent dans ssrf.spec.ts, DNS réel.)
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => [{ address: '8.8.8.8', family: 4 }]),
}));

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('safe-fetcher', () => {
  it('détecte les plages d’IP privées IPv4', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });

  it('détecte les IP privées IPv6', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('::')).toBe(true);
    expect(isPrivateIp('fd00::1')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('2001:4860:4860::8888')).toBe(false);
  });

  describe('comportement réseau (serveur local)', () => {
    let server: Server;
    let baseUrl: string;

    afterEach(async () => {
      await close(server);
    });

    it('ne crashe pas quand le serveur annonce un énorme Content-Length puis coupe la connexion', async () => {
      // Régression nodejs/undici#5360 : corps non lu (parser en pause) + FIN
      // => AssertionError incatchable qui tuait le process.
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100000000' });
        res.write(Buffer.alloc(256 * 1024, 0x61), () => res.socket?.destroy());
      });
      baseUrl = await listen(server);

      const fetcher = new SafeFetcher();
      const result = await fetcher.fetch(`${baseUrl}/giant`, { maxBytes: 1024 * 1024 });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Contenu trop volumineux');
    });

    it('rejette un corps annoncé trop volumineux sans lire le corps', async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '5000000' });
        res.end('x'.repeat(1000));
      });
      baseUrl = await listen(server);

      const fetcher = new SafeFetcher();
      const result = await fetcher.fetch(`${baseUrl}/big`, { maxBytes: 1024 * 1024 });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Contenu trop volumineux');
    });

    it('signale proprement une réponse HTTP en erreur', async () => {
      server = createServer((_req, res) => {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('introuvable');
      });
      baseUrl = await listen(server);

      const fetcher = new SafeFetcher();
      const result = await fetcher.fetch(`${baseUrl}/missing`);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Réponse HTTP 404');
    });

    it('suit les redirections et lit le corps final', async () => {
      server = createServer((req, res) => {
        if (req.url === '/a') {
          res.writeHead(302, { location: '/b' });
          res.end('redirect body');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('#EXTM3U\n#EXTINF:-1,Chaîne test\nhttp://example.com/stream.m3u8');
      });
      baseUrl = await listen(server);

      const fetcher = new SafeFetcher();
      const result = await fetcher.fetch(`${baseUrl}/a`);
      expect(result.ok).toBe(true);
      expect(result.body).toContain('#EXTM3U');
    });

    it('accepte une grosse playlist sous la limite', async () => {
      const body = '#EXTM3U\n' + '#EXTINF:-1,Chaîne test\nhttp://example.com/s.m3u8\n'.repeat(400);
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(body);
      });
      baseUrl = await listen(server);

      const fetcher = new SafeFetcher();
      const result = await fetcher.fetch(`${baseUrl}/playlist`, { maxBytes: 512 * 1024 * 1024 });
      expect(result.ok).toBe(true);
      expect(result.body?.split('\n').length).toBeGreaterThan(100);
    });
  });
});
