import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Source } from '@prisma/client';
import type { SourceKind } from '@mbolo/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { slugify } from '../../common/normalize/slugify';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JobQueue, QueueJob } from '../../common/queue/queue.interface';
import { parseM3u } from './m3u.parser';
import { SafeFetcher } from './safe-fetcher';

interface ImportMetrics {
  read: number;
  created: number;
  updated: number;
  duplicates: number;
  ignored: number;
  errors: number;
}

@Injectable()
export class ImportProcessor implements OnModuleInit {
  private readonly mode: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly queue: JobQueue,
    private readonly config: ConfigService,
  ) {
    this.mode = this.config.get<string>('QUEUE_DRIVER', 'inprocess');
  }

  async onModuleInit(): Promise<void> {
    if (this.mode !== 'inprocess') return;
    await this.queue.process((job: QueueJob) => this.handle(job));
    console.info('[imports] Processeur in-process actif');
  }

  async handle(job: QueueJob): Promise<void> {
    if (job.name !== 'source.import') return;
    const { sourceId, importRunId } = job.payload as { sourceId: string; importRunId: string };
    try {
      await this.run(sourceId, importRunId);
    } catch (error) {
      await this.fail(sourceId, importRunId, 'INTERNAL', error);
    }
  }

  private async run(sourceId: string, importRunId: string): Promise<void> {
    const run = await this.prisma.importRun.findUnique({ where: { id: importRunId } });
    const source = await this.prisma.source.findUnique({ where: { id: sourceId } });
    if (!run || !source) return;
    if (source.status === 'DISABLED') {
      await this.fail(sourceId, importRunId, 'SOURCE_DISABLED', new Error('Source désactivée'));
      return;
    }

    const startedAt = new Date();
    await this.prisma.importRun.update({
      where: { id: importRunId },
      data: { state: 'FETCHING', startedAt },
    });
    await this.prisma.source.update({
      where: { id: sourceId },
      data: { status: 'IMPORTING' },
    });

    const connection = JSON.parse(this.crypto.decrypt(source.connectionEncrypted)) as Record<
      string,
      string
    >;

    let metrics: ImportMetrics;
    if (source.kind === 'M3U') {
      metrics = await this.importM3u(source, connection, importRunId);
    } else {
      await this.fail(sourceId, importRunId, 'UNSUPPORTED_KIND', new Error('Connecteur non implémenté pour ce type de source (Phase 3)'));
      return;
    }

    await this.prisma.importRun.update({
      where: { id: importRunId },
      data: { state: 'COMPLETED', metrics: metrics as unknown as Prisma.InputJsonValue, completedAt: new Date() },
    });
    await this.prisma.source.update({
      where: { id: sourceId },
      data: { status: 'READY', lastSyncedAt: new Date() },
    });
    await this.audit.log(
      source.ownerId,
      'import.completed',
      'source',
      source.id,
      { importRunId, metrics },
    );
  }

  private async importM3u(
    source: Source,
    connection: Record<string, string>,
    importRunId: string,
  ): Promise<ImportMetrics> {
    const url = connection['url'] ?? connection['playlistUrl'];
    if (!url) {
      await this.fail(source.id, importRunId, 'MISSING_URL', new Error('URL de playlist manquante'));
      return { read: 0, created: 0, updated: 0, duplicates: 0, ignored: 0, errors: 0 };
    }

    await this.prisma.importRun.update({
      where: { id: importRunId },
      data: { state: 'PARSING' },
    });

    const fetcher = new SafeFetcher();
    const result = await fetcher.fetch(url);
    if (!result.ok || result.body === undefined) {
      await this.fail(source.id, importRunId, 'FETCH_ERROR', new Error(result.error ?? 'Échec de téléchargement'));
      return { read: 0, created: 0, updated: 0, duplicates: 0, ignored: 0, errors: 0 };
    }

    const parsed = parseM3u(result.body);
    await this.prisma.importRun.update({
      where: { id: importRunId },
      data: { state: 'NORMALIZING' },
    });

    const metrics: ImportMetrics = { read: parsed.length, created: 0, updated: 0, duplicates: 0, ignored: 0, errors: 0 };
    const seenKeys = new Set<string>();

    for (const entry of parsed) {
      try {
        const key = slugify(entry.title);
        if (seenKeys.has(key)) {
          metrics.duplicates += 1;
          continue;
        }
        seenKeys.add(key);

        let categoryId: string | null = null;
        if (entry.groupTitle) {
          const categorySlug = slugify(entry.groupTitle);
          const category = await this.prisma.category.upsert({
            where: { slug: categorySlug },
            update: { name: entry.groupTitle },
            create: { slug: categorySlug, name: entry.groupTitle },
          });
          categoryId = category.id;
        }

        const existingChannel = await this.prisma.channel.findUnique({
          where: { normalizedKey: key },
        });
        if (!existingChannel) {
          await this.prisma.channel.create({
            data: {
              name: entry.title,
              canonicalName: entry.title,
              normalizedKey: key,
              tvgId: entry.tvgId,
              categoryId,
            },
          });
          metrics.created += 1;
        } else {
          if (entry.tvgId || categoryId) {
            await this.prisma.channel.update({
              where: { id: existingChannel.id },
              data: { tvgId: entry.tvgId ?? existingChannel.tvgId, categoryId: categoryId ?? existingChannel.categoryId },
            });
          }
        }

        const channel = existingChannel ?? (await this.prisma.channel.findUnique({ where: { normalizedKey: key } }));
        if (!channel) {
          metrics.errors += 1;
          continue;
        }

        const existingVariant = await this.prisma.streamVariant.findFirst({
          where: { channelId: channel.id, sourceId: source.id },
        });
        if (existingVariant) {
          await this.prisma.streamVariant.update({
            where: { id: existingVariant.id },
            data: {
              encryptedLocator: this.crypto.encrypt(entry.url),
              isActive: true,
            },
          });
          metrics.updated += 1;
        } else {
          await this.prisma.streamVariant.create({
            data: {
              channelId: channel.id,
              sourceId: source.id,
              encryptedLocator: this.crypto.encrypt(entry.url),
            },
          });
          metrics.created += 1;
        }
      } catch {
        metrics.errors += 1;
      }
    }

    metrics.ignored = Math.max(0, metrics.read - metrics.created - metrics.updated - metrics.duplicates - metrics.errors);
    return metrics;
  }

  private async fail(sourceId: string, importRunId: string, errorCode: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    await this.prisma.importRun.update({
      where: { id: importRunId },
      data: {
        state: 'FAILED',
        errorCode,
        errorMessage: this.sanitizeMessage(message, 300),
        completedAt: new Date(),
      },
    });
    await this.prisma.source.update({
      where: { id: sourceId },
      data: { status: 'FAILED' },
    });
  }

  private sanitizeMessage(message: string, maxLength: number): string {
    const withoutUrls = message.replace(/https?:\/\/[^\s]+/g, '[url masquée]');
    return withoutUrls.slice(0, maxLength);
  }
}

export type { SourceKind };