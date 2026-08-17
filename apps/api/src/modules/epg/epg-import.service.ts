import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { SafeFetcher } from '../sources/safe-fetcher';
import { parseXmltvStream, type XmltvProgramme } from './xmltv.parser';

export interface EpgImportResult {
  sources: number;
  channels: number;
  programmes: number;
  stored: number;
  durationMs: number;
}

@Injectable()
export class EpgImportService {
  private readonly logger = new Logger(EpgImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async run(): Promise<EpgImportResult> {
    const startedAt = Date.now();
    const sources = await this.prisma.source.findMany({
      where: { kind: 'XTREAM', status: { not: 'DISABLED' } },
      orderBy: [{ priority: 'asc' }],
    });

    const tvgMap = await this.buildTvgMap();
    if (tvgMap.size === 0) {
      return { sources: 0, channels: 0, programmes: 0, stored: 0, durationMs: Date.now() - startedAt };
    }

    const channelIds = [...tvgMap.values()];
    for (let i = 0; i < channelIds.length; i += 10_000) {
      await this.prisma.epgProgramme.deleteMany({
        where: { channelId: { in: channelIds.slice(i, i + 10_000) } },
      });
    }

    const fetcher = new SafeFetcher();
    const maxBytes = Number(this.config.get('EPG_MAX_BYTES') ?? 512 * 1024 * 1024);
    let channels = 0;
    let programmes = 0;
    let stored = 0;
    let sourcesDone = 0;

    for (const source of sources) {
      try {
        const connection = JSON.parse(
          this.crypto.decrypt(source.connectionEncrypted),
        ) as Record<string, string>;
        const url = this.buildXmltvUrl(connection);
        if (!url) continue;

        const result = await fetcher.fetchStream(url, {
          maxBytes,
          streamTimeoutMs: 15 * 60_000,
          userAgent: 'MboloTV/0.1 (EPG import)',
        });
        if (!result.ok || !result.stream) {
          this.logger.warn(`EPG indisponible pour ${source.name}: ${result.error}`);
          continue;
        }

        const matched = new Set<string>();
        let inserted = 0;
        const parseResult = await parseXmltvStream(result.stream, async (batch: XmltvProgramme[]) => {
          const rows: {
            channelId: string;
            startsAt: Date;
            endsAt: Date;
            title: string;
            description?: string;
            metadata: Prisma.InputJsonValue | undefined;
          }[] = [];
          for (const programme of batch) {
            const channelId = tvgMap.get(programme.channelId.toLowerCase());
            if (!channelId) continue;
            matched.add(channelId);
            rows.push({
              channelId,
              startsAt: programme.startsAt,
              endsAt: programme.endsAt,
              title: programme.title,
              description: programme.description,
              metadata:
                programme.categories.length > 0
                  ? { categories: programme.categories }
                  : undefined,
            });
          }
          if (rows.length === 0) return 0;
          const created = await this.prisma.epgProgramme.createMany({ data: rows });
          return created.count;
        });

        inserted = parseResult.stored;
        channels += matched.size;
        programmes += parseResult.programmes;
        stored += inserted;
        sourcesDone += 1;

        await this.prisma.source.update({
          where: { id: source.id },
          data: { lastSyncedAt: new Date() },
        });
        this.logger.log(
          `EPG ${source.name}: ${matched.size} chaînes, ${inserted} programmes sur ${parseResult.programmes}`,
        );
      } catch (error) {
        this.logger.error(`Échec EPG ${source.name}: ${String(error)}`);
      }
    }

    return {
      sources: sourcesDone,
      channels,
      programmes,
      stored,
      durationMs: Date.now() - startedAt,
    };
  }

  private async buildTvgMap(): Promise<Map<string, string>> {
    const channels = await this.prisma.channel.findMany({
      where: { tvgId: { not: null } },
      select: { id: true, tvgId: true },
    });
    const map = new Map<string, string>();
    for (const channel of channels) {
      if (channel.tvgId) map.set(channel.tvgId.toLowerCase(), channel.id);
    }
    return map;
  }

  private buildXmltvUrl(connection: Record<string, string>): string | null {
    const host = connection['host'] ?? connection['url'];
    const username = connection['username'];
    const password = connection['password'];
    if (!host || !username || !password) return null;
    const base = host.replace(/\/+$/, '');
    return `${base}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  }
}
