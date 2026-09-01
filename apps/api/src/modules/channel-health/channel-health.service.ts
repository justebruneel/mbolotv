import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertSafeUrl, SafeFetcher } from '../sources/safe-fetcher';

export type HealthStatus = 'OK' | 'DOWN';

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_MASTER_BYTES = 1024 * 1024;

interface VariantLike { id: string; encryptedLocator: Uint8Array; }

@Injectable()
export class HealthCheckService {
  private readonly logger = new Logger(HealthCheckService.name);
  private readonly fetcher = new SafeFetcher();
  private readonly staleMs: number;
  private readonly timeoutMs: number;
  private readonly recentDays: number;
  private readonly batchSize: number;
  private scanning = false;

  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, config: ConfigService) {
    this.staleMs = minutes(config.get('HEALTH_CHECK_STALE_MINUTES', 30));
    this.timeoutMs = config.get('HEALTH_CHECK_TIMEOUT_MS', 6_000);
    this.recentDays = config.get('HEALTH_CHECK_RECENT_DAYS', 7);
    this.batchSize = config.get('HEALTH_CHECK_BATCH_SIZE', 10);
  }

  isStale(checkedAt: Date | null): boolean { return !checkedAt || Date.now() - checkedAt.getTime() > this.staleMs; }

  async checkVariant(variant: VariantLike): Promise<HealthStatus> {
    let providerUrl: string;
    try {
      providerUrl = (await assertSafeUrl(this.crypto.decrypt(variant.encryptedLocator))).toString();
    } catch {
      await this.writeResult(variant.id, 'DOWN');
      return 'DOWN';
    }

    let status: HealthStatus = 'DOWN';
    try {
      const result = await this.fetcher.fetch(providerUrl, { maxBytes: MAX_MASTER_BYTES, timeoutMs: this.timeoutMs, userAgent: BROWSER_USER_AGENT });
      status = result.ok && result.status >= 200 && result.status < 400 && isPlaylist(result.body, result.contentType, result.finalUrl) ? 'OK' : 'DOWN';
    } catch {
      status = 'DOWN';
    }
    await this.writeResult(variant.id, status);
    return status;
  }

  async checkVariantIfStale(variant: VariantLike & { healthCheckedAt: Date | null }): Promise<HealthStatus | null> {
    if (!this.isStale(variant.healthCheckedAt)) return null;
    return this.checkVariant(variant);
  }

  async checkVariantIfNeeded(variant: VariantLike & { healthCheckedAt: Date | null; healthStatus: string | null }): Promise<HealthStatus | null> {
    if (variant.healthStatus !== 'DOWN' && !this.isStale(variant.healthCheckedAt)) return null;
    return this.checkVariant(variant);
  }

  async recordFailure(variantId: string): Promise<void> { await this.writeResult(variantId, 'DOWN'); }

  async scanDueVariants(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const since = new Date(Date.now() - this.recentDays * 86_400_000);
      // Les locators Stalker MAC ne peuvent jamais passer un GET manifest :
      // leur santé (sonde handshake via le relais) est portée par le Worker.
      // On les exclut ici, sinon ce scan les marquerait DOWN en masse et
      // dépublierait tout le catalogue MAC côté public.
      const variants = await this.prisma.streamVariant.findMany({ where: { AND: [{ OR: [{ lastPlayedAt: { gte: since } }, { healthCheckedAt: null }, { healthStatus: 'DOWN' }] }, { source: { kind: { not: 'MAC_PORTAL' } } }] }, orderBy: { healthCheckedAt: 'asc' }, take: this.batchSize });
      if (variants.length === 0) return;
      this.logger.log(`Health-check de ${variants.length} variantes`);
      for (const variant of variants) {
        if (variant.healthStatus !== 'DOWN' && !this.isStale(variant.healthCheckedAt)) continue;
        const status = await this.checkVariant(variant);
        if (status === 'DOWN') this.logger.warn(`Variante ${variant.id} signalée hors ligne`);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    } finally {
      this.scanning = false;
    }
  }

  private async writeResult(variantId: string, status: HealthStatus): Promise<void> {
    try {
      await this.prisma.streamVariant.update({ where: { id: variantId }, data: { healthStatus: status, healthCheckedAt: new Date() } });
    } catch (error) {
      this.logger.warn(`Impossible d'enregistrer le statut de la variante ${variantId}: ${String(error)}`);
    }
  }

  @Cron(process.env.HEALTH_CHECK_CRON ?? '*/10 * * * *')
  async scheduledScan(): Promise<void> { await this.scanDueVariants(); }
}

function isPlaylist(body: string | undefined, contentType: string | undefined, finalUrl: string | undefined): boolean {
  if (contentType && /mpegurl|application\/vnd\.apple\.mpegurl/i.test(contentType)) return true;
  if (finalUrl && /\.m3u8?(\?|$)/i.test(finalUrl)) return true;
  return typeof body === 'string' && /^\s*#EXTM3U(?:\s|$)/i.test(body);
}

function minutes(value: unknown): number { return Number(value ?? 30) * 60_000; }
