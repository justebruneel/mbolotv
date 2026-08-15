import {
  BadGatewayException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { PlayResponse } from '@mbolo/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HealthCheckService } from '../channel-health/channel-health.service';
import { assertSafeUrl } from '../sources/safe-fetcher';
import { StreamSession, StreamSessionStore } from './stream-session.store';

export interface StreamContext {
  session: StreamSession;
  sessionId: string;
}

const DEFAULT_PUBLIC_API_URL = 'http://localhost:4000';

@Injectable()
export class StreamingService {
  private readonly idleTtlMs: number;
  private readonly absoluteTtlMs: number;
  private readonly aliasTtlMs: number;
  private readonly extraHostnames: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly store: StreamSessionStore,
    private readonly audit: AuditService,
    private readonly health: HealthCheckService,
    private readonly config: ConfigService,
  ) {
    this.idleTtlMs = minutes(this.config.get('STREAM_IDLE_TTL_MINUTES', 240));
    this.absoluteTtlMs = hours(this.config.get('STREAM_ABSOLUTE_TTL_HOURS', 24));
    this.aliasTtlMs = hours(this.config.get('STREAM_ALIAS_TTL_HOURS', 6));
    this.extraHostnames = (this.config.get<string>('STREAM_ALLOWED_HOSTS', '') ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
  }

  async createPlay(channelId: string): Promise<PlayResponse> {
    const variants = await this.prisma.streamVariant.findMany({
      where: {
        channelId,
        isActive: true,
        source: { status: { not: 'DISABLED' } },
      },
      orderBy: [{ healthScore: 'desc' }, { source: { priority: 'asc' } }],
      include: { source: true },
    });
    if (variants.length === 0) {
      throw new NotFoundException('Aucun flux disponible pour cette chaîne');
    }

    // Failover : écarte les variantes déjà signalées hors ligne, sinon repli sur la meilleure
    const variant = variants.find((item) => item.healthStatus !== 'DOWN') ?? variants[0];

    // Refresh d'état non bloquant (badge / prochaine sélection)
    void this.health.checkVariantIfStale(variant).catch(() => undefined);
    void this.prisma.streamVariant
      .update({ where: { id: variant.id }, data: { lastPlayedAt: new Date() } })
      .catch(() => undefined);

    let providerUrl: string;
    try {
      providerUrl = this.crypto.decrypt(variant.encryptedLocator);
      const url = await assertSafeUrl(providerUrl);
      providerUrl = url.toString();
    } catch {
      throw new NotFoundException('Flux indisponible pour cette chaîne');
    }

    const providerHostname = new URL(providerUrl).hostname.toLowerCase();
    const session = this.store.create(
      {
        channelId,
        variantId: variant.id,
        sourceId: variant.sourceId,
        providerHostname,
      },
      this.idleTtlMs,
      this.absoluteTtlMs,
    );
    this.store.addAlias(session.id, 'master', providerUrl, this.aliasTtlMs);

    await this.audit.log(null, 'stream.session_created', 'channel', channelId, {
      sessionId: session.id,
      variantId: variant.id,
    });

    const publicApiUrl =
      this.config.get<string>('PUBLIC_API_URL') ??
      this.config.get<string>('API_URL') ??
      DEFAULT_PUBLIC_API_URL;

    return {
      url: `${publicApiUrl.replace(/\/+$/, '')}/api/stream/${session.id}/master.m3u8`,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  assertSession(sessionId: string): StreamSession {
    const session = this.store.get(sessionId);
    if (!session) {
      throw new NotFoundException('Session de lecture invalide ou expirée');
    }
    this.store.touch(sessionId, this.idleTtlMs);
    return session;
  }

  resolveProviderUrl(session: StreamSession, alias?: string): string {
    const aliasId = alias ?? 'master';
    const providerUrl = this.store.getAlias(session.id, aliasId);
    if (!providerUrl) {
      throw new NotFoundException('Ressource de lecture indisponible');
    }
    return providerUrl;
  }

  registerAlias(session: StreamSession, absoluteUrl: string): string {
    const hostname = new URL(absoluteUrl).hostname.toLowerCase();
    if (!this.isHostAllowed(hostname, session)) {
      throw new BadGatewayException('Hôte fournisseur non autorisé');
    }
    const key = stableSegmentKey(absoluteUrl);
    const existing = this.store.getAliasByKey(session.id, key);
    if (existing) {
      this.store.addAlias(session.id, existing, absoluteUrl, this.aliasTtlMs);
      return `/api/stream/${session.id}/f/${existing}`;
    }
    const alias = randomBytes(10).toString('base64url');
    this.store.addAlias(session.id, alias, absoluteUrl, this.aliasTtlMs);
    this.store.setAliasByKey(session.id, key, alias);
    return `/api/stream/${session.id}/f/${alias}`;
  }

  async registerDiscoveredHost(session: StreamSession, absoluteUrl: string): Promise<void> {
    try {
      const hostname = new URL(absoluteUrl).hostname.toLowerCase();
      if (this.isHostAllowed(hostname, session)) return;
      const url = await assertSafeUrl(absoluteUrl);
      const finalHostname = url.hostname.toLowerCase();
      if (!session.discoveredHosts.includes(finalHostname)) {
        session.discoveredHosts.push(finalHostname);
      }
    } catch {
      // Hôte invalide ou non public : on ne l'ajoute pas aux hôtes autorisés.
    }
  }

  allowedHostnames(session: StreamSession): Set<string> {
    return new Set([session.providerHostname, ...session.discoveredHosts, ...this.extraHostnames]);
  }

  private isHostAllowed(hostname: string, session: StreamSession): boolean {
    const allowed = [session.providerHostname, ...session.discoveredHosts, ...this.extraHostnames];
    return allowed.some((allowedHost) => {
      const allowedLower = allowedHost.toLowerCase();
      return hostname === allowedLower || hostname.endsWith(`.${allowedLower}`);
    });
  }
}

function minutes(value: number): number {
  return value * 60_000;
}

function hours(value: number): number {
  return value * 3_600_000;
}

function stableSegmentKey(url: string): string {
  try {
    const path = new URL(url).pathname;
    const filename = path.split('/').filter(Boolean).pop();
    return filename ?? url;
  } catch {
    return url;
  }
}
