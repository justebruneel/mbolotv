import {
  BadGatewayException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import type { PlayResponse } from '@mbolo/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HealthCheckService } from '../channel-health/channel-health.service';
import { assertSafeUrl } from '../sources/safe-fetcher';
import { HostValidationCache } from './host-validation.cache';
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
    private readonly hostValidation: HostValidationCache = new HostValidationCache(),
  ) {
    this.idleTtlMs = minutes(this.config.get('STREAM_IDLE_TTL_MINUTES', 240));
    this.absoluteTtlMs = hours(this.config.get('STREAM_ABSOLUTE_TTL_HOURS', 24));
    this.aliasTtlMs = hours(this.config.get('STREAM_ALIAS_TTL_HOURS', 6));
    this.extraHostnames = (this.config.get<string>('STREAM_ALLOWED_HOSTS', '') ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  }

  async createPlay(channelId: string): Promise<PlayResponse> {
    const variants = await this.prisma.streamVariant.findMany({ where: { channelId, isActive: true, source: { status: { not: 'DISABLED' } } }, orderBy: [{ healthScore: 'desc' }, { source: { priority: 'asc' } }], include: { source: true } });
    if (variants.length === 0) throw new NotFoundException('Aucun flux disponible pour cette chaîne');
    const variant = variants.find((item) => item.healthStatus !== 'DOWN') ?? variants[0];
    void this.health.checkVariantIfNeeded(variant).catch(() => undefined);
    void this.prisma.streamVariant.update({ where: { id: variant.id }, data: { lastPlayedAt: new Date() } }).catch(() => undefined);
    return this.openSession(channelId, variant);
  }

  async openSession(channelId: string, variant: { id: string; sourceId: string; encryptedLocator: Uint8Array }): Promise<PlayResponse> {
    let providerUrl: string;
    try {
      providerUrl = this.crypto.decrypt(variant.encryptedLocator);
      providerUrl = (await assertSafeUrl(providerUrl)).toString();
    } catch {
      throw new NotFoundException('Flux indisponible pour cette chaîne');
    }
    const providerHostname = new URL(providerUrl).hostname.toLowerCase();
    const session = this.store.create({ channelId, variantId: variant.id, sourceId: variant.sourceId, providerHostname }, this.idleTtlMs, this.absoluteTtlMs);
    this.store.addAlias(session.id, 'master', providerUrl, this.aliasTtlMs);
    await this.audit.log(null, 'stream.session_created', 'channel', channelId, { sessionId: session.id, variantId: variant.id });
    const publicApiUrl = (this.config.get<string>('PUBLIC_API_URL') ?? this.config.get<string>('API_URL') ?? DEFAULT_PUBLIC_API_URL).replace(/\/+$/, '');
    return { url: `${publicApiUrl}/api/stream/${session.id}/master.m3u8`, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  assertSession(sessionId: string): StreamSession {
    const session = this.store.get(sessionId);
    if (!session) throw new NotFoundException('Session de lecture invalide ou expirée');
    this.store.touch(sessionId, this.idleTtlMs);
    return session;
  }

  resolveProviderUrl(session: StreamSession, alias?: string): string {
    const providerUrl = this.store.getAlias(session.id, alias ?? 'master');
    if (!providerUrl) throw new NotFoundException('Ressource de lecture indisponible');
    return providerUrl;
  }

  registerAlias(session: StreamSession, absoluteUrl: string): string {
    let url: URL;
    try { url = new URL(absoluteUrl); } catch { throw new BadGatewayException('URL fournisseur invalide'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BadGatewayException('Protocole fournisseur non autorisé');
    const hostname = url.hostname.toLowerCase();
    if (!this.isHostAllowed(hostname, session) && !session.discoveredHosts.includes(hostname)) session.discoveredHosts.push(hostname);
    const key = stableSegmentKey(url);
    const existing = this.store.getAliasByKey(session.id, key);
    if (existing) {
      this.store.addAlias(session.id, existing, url.toString(), this.aliasTtlMs);
      return `/api/stream/${session.id}/f/${existing}`;
    }
    const alias = randomBytes(10).toString('base64url');
    this.store.addAlias(session.id, alias, url.toString(), this.aliasTtlMs);
    this.store.setAliasByKey(session.id, key, alias);
    return `/api/stream/${session.id}/f/${alias}`;
  }

  async registerDiscoveredHost(session: StreamSession, absoluteUrl: string): Promise<void> {
    try {
      const url = new URL(absoluteUrl);
      const hostname = url.hostname.toLowerCase();
      if (this.isHostAllowed(hostname, session)) return;
      await this.hostValidation.assertSafeHost(url);
      if (!session.discoveredHosts.includes(hostname)) session.discoveredHosts.push(hostname);
    } catch {
      // Hôte invalide ou non public : on ne l'ajoute pas aux hôtes autorisés.
    }
  }

  allowedHostnames(session: StreamSession): Set<string> {
    return new Set([session.providerHostname, ...session.discoveredHosts, ...this.extraHostnames]);
  }

  private isHostAllowed(hostname: string, session: StreamSession): boolean {
    return [session.providerHostname, ...session.discoveredHosts, ...this.extraHostnames].some((allowedHost) => {
      const allowedLower = allowedHost.toLowerCase();
      return hostname === allowedLower || hostname.endsWith(`.${allowedLower}`);
    });
  }
}

function minutes(value: number): number { return value * 60_000; }
function hours(value: number): number { return value * 3_600_000; }

function stableSegmentKey(url: URL): string {
  // Le nom de fichier seul collisionne souvent entre les variantes et les CDN.
  // La clé inclut l’URL normalisée complète, y compris query string et hôte.
  return createHash('sha256').update(url.toString()).digest('base64url').slice(0, 32);
}
