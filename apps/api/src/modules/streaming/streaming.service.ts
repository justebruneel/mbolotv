import { BadGatewayException, Injectable, NotFoundException } from '@nestjs/common';
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

export interface StreamContext { session: StreamSession; sessionId: string; }
const DEFAULT_PUBLIC_API_URL = 'http://localhost:4000';

@Injectable()
export class StreamingService {
  private readonly idleTtlMs: number;
  private readonly absoluteTtlMs: number;
  private readonly aliasTtlMs: number;
  private readonly extraHostnames: string[];
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly store: StreamSessionStore, private readonly audit: AuditService, private readonly health: HealthCheckService, private readonly config: ConfigService, private readonly hostValidation: HostValidationCache = new HostValidationCache()) {
    this.idleTtlMs = Number(this.config.get('STREAM_IDLE_TTL_MINUTES', 240)) * 60_000;
    this.absoluteTtlMs = Number(this.config.get('STREAM_ABSOLUTE_TTL_HOURS', 24)) * 3_600_000;
    this.aliasTtlMs = Number(this.config.get('STREAM_ALIAS_TTL_HOURS', 6)) * 3_600_000;
    this.extraHostnames = (this.config.get<string>('STREAM_ALLOWED_HOSTS', '') ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  }
  async createPlay(channelId: string, deviceId: string | undefined): Promise<PlayResponse> {
    const variants = await this.prisma.streamVariant.findMany({ where: { channelId, isActive: true, source: { status: { not: 'DISABLED' } } }, orderBy: [{ healthScore: 'desc' }, { source: { priority: 'asc' } }], include: { source: true } });
    if (variants.length === 0) throw new NotFoundException('Aucun flux disponible pour cette chaîne');
    const variant = variants.find((item) => item.healthStatus !== 'DOWN') ?? variants[0];
    void this.health.checkVariantIfNeeded(variant).catch(() => undefined);
    void this.prisma.streamVariant.update({ where: { id: variant.id }, data: { lastPlayedAt: new Date() } }).catch(() => undefined);
    return this.openSession(channelId, variant, deviceId);
  }
  async openSession(channelId: string, variant: { id: string; sourceId: string; encryptedLocator: Uint8Array }, deviceId: string | undefined): Promise<PlayResponse> {
    let providerUrl: string;
    try { providerUrl = (await assertSafeUrl(this.crypto.decrypt(variant.encryptedLocator))).toString(); } catch { throw new NotFoundException('Flux indisponible pour cette chaîne'); }
    const session = await this.store.create({ channelId, variantId: variant.id, sourceId: variant.sourceId, providerHostname: new URL(providerUrl).hostname.toLowerCase(), deviceId: deviceId ?? '' }, this.idleTtlMs, this.absoluteTtlMs);
    await this.store.addAlias(session.id, 'master', providerUrl, this.aliasTtlMs);
    // L’audit ne doit pas retarder l’émission de l’URL HLS. Une panne Neon ne doit
    // jamais transformer le lancement du player en écran de chargement.
    void this.audit.log(null, 'stream.session_created', 'channel', channelId, { sessionId: session.id, variantId: variant.id }).catch(() => undefined);
    const publicApiUrl = (this.config.get<string>('PUBLIC_API_URL') ?? this.config.get<string>('API_URL') ?? DEFAULT_PUBLIC_API_URL).replace(/\/+$/, '');
    return { url: `${publicApiUrl}/api/stream/${session.id}/master.m3u8`, expiresAt: new Date(session.expiresAt).toISOString() };
  }
  async assertSession(sessionId: string): Promise<StreamSession> { const session = await this.store.get(sessionId); if (!session) throw new NotFoundException('Session de lecture invalide ou expirée'); void this.store.touch(sessionId, this.idleTtlMs).catch(() => undefined); return session; }
  async resolveProviderUrl(session: StreamSession, alias = 'master'): Promise<string> { const url = await this.store.getAlias(session.id, alias); if (!url) throw new NotFoundException('Ressource de lecture indisponible'); return url; }
  async registerAlias(session: StreamSession, absoluteUrl: string): Promise<string> {
    let url: URL; try { url = new URL(absoluteUrl); } catch { throw new BadGatewayException('URL fournisseur invalide'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BadGatewayException('Protocole fournisseur non autorisé');
    const hostname = url.hostname.toLowerCase();
    if (!this.isHostAllowed(hostname, session) && !session.discoveredHosts.includes(hostname)) { session.discoveredHosts.push(hostname); await this.store.update(session); }
    const key = createHash('sha256').update(url.toString()).digest('base64url').slice(0, 32);
    const existing = await this.store.getAliasByKey(session.id, key);
    if (existing) { await this.store.addAlias(session.id, existing, url.toString(), this.aliasTtlMs); return `/api/stream/${session.id}/f/${existing}`; }
    const alias = randomBytes(10).toString('base64url');
    await this.store.addAlias(session.id, alias, url.toString(), this.aliasTtlMs);
    await this.store.setAliasByKey(session.id, key, alias);
    return `/api/stream/${session.id}/f/${alias}`;
  }
  async registerDiscoveredHost(session: StreamSession, absoluteUrl: string): Promise<void> { try { const url = new URL(absoluteUrl); if (this.isHostAllowed(url.hostname.toLowerCase(), session)) return; await this.hostValidation.assertSafeHost(url); if (!session.discoveredHosts.includes(url.hostname.toLowerCase())) { session.discoveredHosts.push(url.hostname.toLowerCase()); await this.store.update(session); } } catch { /* invalid CDN host is ignored */ } }
  allowedHostnames(session: StreamSession): Set<string> { return new Set([session.providerHostname, ...session.discoveredHosts, ...this.extraHostnames]); }
  private isHostAllowed(hostname: string, session: StreamSession): boolean { return [session.providerHostname, ...session.discoveredHosts, ...this.extraHostnames].some((host) => hostname === host || hostname.endsWith(`.${host}`)); }
}
