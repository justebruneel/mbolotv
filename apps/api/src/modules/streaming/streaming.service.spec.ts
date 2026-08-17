import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HealthCheckService } from '../channel-health/channel-health.service';
import { InMemoryStreamSessionStore, StreamSessionStore } from './stream-session.store';
import { StreamingService } from './streaming.service';

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

describe('StreamingService', () => {
  let service: StreamingService;
  let prisma: { streamVariant: { findMany: jest.Mock; update: jest.Mock } };
  let crypto: { decrypt: jest.Mock };
  let store: InMemoryStreamSessionStore;
  let audit: { log: jest.Mock };
  let health: { checkVariantIfStale: jest.Mock; checkVariantIfNeeded: jest.Mock; checkVariant: jest.Mock };

  const variant = {
    id: 'variant-1',
    channelId: 'ch-1',
    sourceId: 'source-1',
    source: { priority: 100 },
    encryptedLocator: new Uint8Array([1, 2, 3]),
    healthScore: 0.8,
    healthStatus: null,
    healthCheckedAt: null,
    lastPlayedAt: null,
    isActive: true,
  };

  function createService(publicApiUrl = 'http://api.example.com'): StreamingService {
    const config = {
      get: (key: string, fallback: number | string) => {
        const overrides: Record<string, number | string> = {
          STREAM_IDLE_TTL_MINUTES: 240,
          STREAM_ABSOLUTE_TTL_HOURS: 24,
          STREAM_ALIAS_TTL_HOURS: 6,
          STREAM_ALLOWED_HOSTS: '',
          PUBLIC_API_URL: publicApiUrl,
        };
        return key in overrides ? overrides[key] : fallback;
      },
    } as unknown as ConfigService;
    store = new InMemoryStreamSessionStore(config);
    service = new StreamingService(
      prisma as unknown as PrismaService,
      crypto as unknown as CryptoService,
      store as unknown as StreamSessionStore,
      audit as unknown as AuditService,
      health as unknown as HealthCheckService,
      config,
    );
    return service;
  }

  beforeEach(() => {
    prisma = {
      streamVariant: { findMany: jest.fn(), update: jest.fn().mockResolvedValue(undefined) },
    };
    crypto = { decrypt: jest.fn() };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    health = {
      checkVariantIfStale: jest.fn().mockResolvedValue(null),
      checkVariantIfNeeded: jest.fn().mockResolvedValue(null),
      checkVariant: jest.fn().mockResolvedValue('OK'),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('crée une session et renvoie une URL gateway sans URL fournisseur', async () => {
    createService();
    prisma.streamVariant.findMany.mockResolvedValue([variant]);
    crypto.decrypt.mockReturnValue('https://provider.example.com/live/playlist.m3u8');

    const play = await service.createPlay('ch-1');

    expect(play.url).toMatch(/^http:\/\/api\.example\.com\/api\/stream\/[^/]+\/master\.m3u8$/);
    expect(play.url).not.toContain('provider.example.com');
    expect(play.expiresAt).toBeDefined();
    expect(audit.log).toHaveBeenCalledWith(null, 'stream.session_created', 'channel', 'ch-1', expect.any(Object));

    const sessionId = play.url.split('/stream/')[1].split('/')[0];
    const session = store.get(sessionId);
    expect(session).toBeDefined();
    expect(store.getAlias(sessionId, 'master')).toBe(
      'https://provider.example.com/live/playlist.m3u8',
    );
  });

  it('renvoie 404 si aucune variante active', async () => {
    createService();
    prisma.streamVariant.findMany.mockResolvedValue([]);

    await expect(service.createPlay('ch-1')).rejects.toThrow(NotFoundException);
  });

  it('renvoie 404 si le locator ne se déchiffre pas ou est invalide', async () => {
    createService();
    prisma.streamVariant.findMany.mockResolvedValue([variant]);
    crypto.decrypt.mockReturnValue('not a url');

    await expect(service.createPlay('ch-1')).rejects.toThrow(NotFoundException);
  });

  it('renvoie 404 si une session inconnue ou expirée est demandée', () => {
    createService();
    expect(() => service.assertSession('inconnu')).toThrow(NotFoundException);

    prisma.streamVariant.findMany.mockResolvedValue([variant]);
    crypto.decrypt.mockReturnValue('https://provider.example.com/live/playlist.m3u8');
    const play = service.createPlay('ch-1');
    void play;
    const session = store.create(
      { channelId: 'ch-1', variantId: 'v', sourceId: 's', providerHostname: 'h' },
      -1,
      -1,
    );
    expect(() => service.assertSession(session.id)).toThrow(NotFoundException);
  });

  it('autorise un alias sur le même hôte ou un sous-domaine, découvre un hôte étranger', () => {
    createService();
    const session = store.create(
      {
        channelId: 'ch-1',
        variantId: 'v',
        sourceId: 's',
        providerHostname: 'provider.example.com',
      },
      60_000,
      3_600_000,
    );

    expect(
      service.registerAlias(session, 'https://cdn.provider.example.com/seg.ts'),
    ).toMatch(/^\/api\/stream\/[^/]+\/f\/[^/]+$/);

    // Un hôte référencé par le contenu d'une playlist (CDN, edge…) est découvert
    // à la volée : la protection SSRF reste appliquée au moment du fetch effectif.
    const alias = service.registerAlias(session, 'https://evil.com/seg.ts');
    expect(alias).toMatch(/^\/api\/stream\/[^/]+\/f\/[^/]+$/);
    expect(service.allowedHostnames(session).has('evil.com')).toBe(true);
  });

  it('refuse un alias à protocole ou URL invalide', () => {
    createService();
    const session = store.create(
      {
        channelId: 'ch-1',
        variantId: 'v',
        sourceId: 's',
        providerHostname: 'provider.example.com',
      },
      60_000,
      3_600_000,
    );

    expect(() => service.registerAlias(session, 'ftp://example.com/seg.ts')).toThrow(
      BadGatewayException,
    );
    expect(() => service.registerAlias(session, 'not a url')).toThrow(BadGatewayException);
  });

  it('réutilise le même alias pour un segment dont seule l’URL change entre rechargements', () => {
    createService();
    const session = store.create(
      {
        channelId: 'ch-1',
        variantId: 'v',
        sourceId: 's',
        providerHostname: '103.209.129.50',
      },
      60_000,
      3_600_000,
    );

    const first = service.registerAlias(
      session,
      'http://103.209.129.50/hlsr/tokenA/MAGU6F9JNR/HLNwuVM80Z/60117/e86ad5f8f9d845565ab031c34dc1d2a5/60117_56.ts',
    );
    const second = service.registerAlias(
      session,
      'http://103.209.129.50/hlsr/tokenB/MAGU6F9JNR/HLNwuVM80Z/60117/e86ad5f8f9d845565ab031c34dc1d2a5/60117_56.ts',
    );
    expect(second).toBe(first);

    const alias = first.split('/f/')[1];
    expect(service.resolveProviderUrl(session, alias)).toBe(
      'http://103.209.129.50/hlsr/tokenB/MAGU6F9JNR/HLNwuVM80Z/60117/e86ad5f8f9d845565ab031c34dc1d2a5/60117_56.ts',
    );
  });

  it('crée un alias distinct pour un autre segment', () => {
    createService();
    const session = store.create(
      {
        channelId: 'ch-1',
        variantId: 'v',
        sourceId: 's',
        providerHostname: '103.209.129.50',
      },
      60_000,
      3_600_000,
    );

    const a = service.registerAlias(
      session,
      'http://103.209.129.50/hlsr/tokenA/MAGU6F9JNR/HLNwuVM80Z/60117/x/60117_55.ts',
    );
    const b = service.registerAlias(
      session,
      'http://103.209.129.50/hlsr/tokenA/MAGU6F9JNR/HLNwuVM80Z/60117/y/60117_56.ts',
    );
    expect(a).not.toBe(b);
  });

  it('autorise les hôtes référencés par une playlist sans redirection préalable', () => {
    createService();
    const session = store.create(
      {
        channelId: 'ch-1',
        variantId: 'v',
        sourceId: 's',
        providerHostname: 'provider.example.com',
      },
      60_000,
      3_600_000,
    );

    expect(
      service.registerAlias(session, 'https://cdn-cdn.example.com/seg.ts'),
    ).toMatch(/^\/api\/stream\/[^/]+\/f\/[^/]+$/);
    expect(service.allowedHostnames(session).has('cdn-cdn.example.com')).toBe(true);
  });

  it('refuse d’enregistrer un hôte invalide ou à protocole non autorisé', async () => {
    createService();
    const session = store.create(
      {
        channelId: 'ch-1',
        variantId: 'v',
        sourceId: 's',
        providerHostname: 'provider.example.com',
      },
      60_000,
      3_600_000,
    );

    await service.registerDiscoveredHost(session, 'not a url');
    await service.registerDiscoveredHost(session, 'ftp://example.com/seg.ts');
    expect(session.discoveredHosts).toEqual([]);
  });

  it('résout le master et les alias depuis le store', () => {
    createService();
    const session = store.create(
      {
        channelId: 'ch-1',
        variantId: 'v',
        sourceId: 's',
        providerHostname: 'provider.example.com',
      },
      60_000,
      3_600_000,
    );
    store.addAlias(session.id, 'master', 'https://provider.example.com/a.m3u8', 60_000);
    store.addAlias(session.id, 'x', 'https://provider.example.com/seg.ts', 60_000);

    expect(service.resolveProviderUrl(session)).toBe('https://provider.example.com/a.m3u8');
    expect(service.resolveProviderUrl(session, 'x')).toBe('https://provider.example.com/seg.ts');
    expect(() => service.resolveProviderUrl(session, 'inconnu')).toThrow(NotFoundException);
  });
});
