import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InMemoryStreamSessionStore, StreamSessionStore } from './stream-session.store';
import { StreamingService } from './streaming.service';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }));

describe('StreamingService', () => {
  let service: StreamingService;
  let prisma: { streamVariant: { findMany: jest.Mock; update: jest.Mock } };
  let crypto: { decrypt: jest.Mock };
  let store: InMemoryStreamSessionStore;
  let audit: { log: jest.Mock };
  let health: { checkVariantIfNeeded: jest.Mock };
  const variant = { id: 'variant-1', channelId: 'ch-1', sourceId: 'source-1', source: { priority: 100 }, encryptedLocator: new Uint8Array([1]), healthScore: 0.8, healthStatus: null, healthCheckedAt: null, lastPlayedAt: null, isActive: true };

  beforeEach(() => {
    prisma = { streamVariant: { findMany: jest.fn(), update: jest.fn().mockResolvedValue(undefined) } };
    crypto = { decrypt: jest.fn() };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    health = { checkVariantIfNeeded: jest.fn().mockResolvedValue(null) };
    const config = { get: (key: string, fallback: number | string) => ({ STREAM_IDLE_TTL_MINUTES: 240, STREAM_ABSOLUTE_TTL_HOURS: 24, STREAM_ALIAS_TTL_HOURS: 6, STREAM_ALLOWED_HOSTS: '', PUBLIC_API_URL: 'http://api.example.com' } as Record<string, number | string>)[key] ?? fallback } as unknown as ConfigService;
    store = new InMemoryStreamSessionStore();
    service = new StreamingService(prisma as never, crypto as never, store as unknown as StreamSessionStore, audit as never, health as never, config);
  });

  it('crée une session gateway sans URL fournisseur', async () => {
    prisma.streamVariant.findMany.mockResolvedValue([variant]);
    crypto.decrypt.mockReturnValue('https://provider.example.com/live/playlist.m3u8');
    const play = await service.createPlay('ch-1', undefined);
    expect(play.url).toMatch(/^http:\/\/api\.example\.com\/api\/stream\/[^/]+\/master\.m3u8$/);
    expect(play.url).not.toContain('provider.example.com');
    const id = play.url.split('/stream/')[1].split('/')[0];
    expect(await store.get(id)).toBeDefined();
    expect(await store.getAlias(id, 'master')).toContain('provider.example.com');
  });

  it('renvoie l’URL signée du Worker vidéo quand VIDEO_PROXY_URL est définie', async () => {
    const config = { get: (key: string, fallback: number | string) => ({ STREAM_IDLE_TTL_MINUTES: 240, STREAM_ABSOLUTE_TTL_HOURS: 24, STREAM_ALIAS_TTL_HOURS: 6, STREAM_ALLOWED_HOSTS: '', PUBLIC_API_URL: 'http://api.example.com', VIDEO_PROXY_URL: 'https://mbolo-tv-video-proxy.example.workers.dev' } as Record<string, number | string>)[key] ?? fallback } as unknown as ConfigService;
    const proxied = new StreamingService(prisma as never, crypto as never, new InMemoryStreamSessionStore() as unknown as StreamSessionStore, audit as never, health as never, config);
    prisma.streamVariant.findMany.mockResolvedValue([variant]);
    crypto.decrypt.mockReturnValue('https://provider.example.com/live/playlist.m3u8?token=abc');
    const play = await proxied.createPlay('ch-1', undefined);
    expect(play.url).toMatch(/^https:\/\/mbolo-tv-video-proxy\.example\.workers\.dev\/\?url=https%3A%2F%2Fprovider\.example\.com%2Flive%2Fplaylist\.m3u8%3Ftoken%3Dabc&x-exp=\d+&x-sig=[0-9a-f]{64}$/);
    const decoded = decodeURIComponent(play.url.split('?url=')[1].split('&x-exp=')[0]);
    expect(decoded).toBe('https://provider.example.com/live/playlist.m3u8?token=abc');
  });

  it('refuse une chaîne sans variante ou avec locator invalide', async () => {
    prisma.streamVariant.findMany.mockResolvedValue([]);
    await expect(service.createPlay('ch-1', undefined)).rejects.toThrow(NotFoundException);
    prisma.streamVariant.findMany.mockResolvedValue([variant]);
    crypto.decrypt.mockReturnValue('not a url');
    await expect(service.createPlay('ch-1', undefined)).rejects.toThrow(NotFoundException);
  });

  it('crée des alias distincts pour des URLs distinctes', async () => {
    const session = await store.create({ channelId: 'ch-1', variantId: 'v', sourceId: 's', deviceId: '', providerHostname: 'provider.example.com' }, 60_000, 3_600_000);
    const first = await service.registerAlias(session, 'https://cdn.example.com/a.ts?token=1');
    const second = await service.registerAlias(session, 'https://cdn.example.com/a.ts?token=2');
    expect(first).not.toBe(second);
    expect(await service.resolveProviderUrl(session, first.split('/f/')[1])).toContain('token=1');
  });

  it('rejette les alias non HTTP', async () => {
    const session = await store.create({ channelId: 'ch-1', variantId: 'v', sourceId: 's', deviceId: '', providerHostname: 'provider.example.com' }, 60_000, 3_600_000);
    await expect(service.registerAlias(session, 'ftp://example.com/a.ts')).rejects.toThrow();
  });
});
