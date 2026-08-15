import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Source } from '@prisma/client';
import type { SourceKind } from '@mbolo/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { slugify } from '../../common/normalize/slugify';
import { detectCountry } from '../../common/normalize/country';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JobQueue, QueueJob } from '../../common/queue/queue.interface';
import { parseM3u, type ParsedChannel } from './m3u.parser';
import { fetchXtreamEntries } from './xtream.connector';
import { fetchMacPortalEntries } from './mac-portal.connector';
import { SafeFetcher } from './safe-fetcher';

interface ImportMetrics {
  read: number;
  created: number;
  updated: number;
  duplicates: number;
  ignored: number;
  errors: number;
}

// Une sous-playlist conteneur (dossier de chaînes) est un #EXTM3U sans
// #EXT-X-STREAM-INF dont les entrées #EXTINF pointent vers d'autres playlists
// (.m3u/.m3u8) plutôt que vers des segments média (.ts, .mp4, …).
function isSubplaylistContainer(content: string): boolean {
  if (!content.includes('#EXTM3U')) return false;
  if (content.includes('#EXT-X-STREAM-INF')) return false;

  const lines = content.split(/\r?\n/);
  let awaitingUrl = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('#EXTINF:')) {
      awaitingUrl = true;
      continue;
    }
    if (line.startsWith('#') || !line) continue;
    if (!awaitingUrl) continue;
    awaitingUrl = false;
    if (/\.m3u8?(\?|$)/i.test(line)) return true;
  }
  return false;
}

@Injectable()
export class ImportProcessor implements OnModuleInit {
  private readonly mode: string;
  private readonly probeSubplaylists: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly queue: JobQueue,
    private readonly config: ConfigService,
  ) {
    this.mode = this.config.get<string>('QUEUE_DRIVER', 'inprocess');
    this.probeSubplaylists =
      this.config.get<string>('IMPORT_SUBPLAYLIST_PROBE', 'false') === 'true';
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
    } else if (source.kind === 'XTREAM') {
      metrics = await this.importXtream(source, connection, importRunId);
    } else if (source.kind === 'MAC_PORTAL') {
      metrics = await this.importMacPortal(source, connection, importRunId);
    } else {
      await this.fail(sourceId, importRunId, 'UNSUPPORTED_KIND', new Error('Type de source non pris en charge'));
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
    const entries = this.probeSubplaylists ? await this.probeSubplaylistEntries(parsed) : parsed;
    return this.ingestEntries(source, entries, importRunId);
  }

  /**
   * Détecte les sous-playlists imbriquées : une entrée dont l'URL pointe vers
   * une playlist qui liste d'autres playlists (un dossier de chaînes) plutôt
   * qu'un flux direct. Activable via IMPORT_SUBPLAYLIST_PROBE=true.
   */
  private async probeSubplaylistEntries(entries: ParsedChannel[]): Promise<ParsedChannel[]> {
    const kept: ParsedChannel[] = [];
    const fetcher = new SafeFetcher();
    for (const entry of entries) {
      const result = await fetcher.fetch(entry.url, { maxBytes: 256 * 1024, timeoutMs: 10_000 });
      if (!result.ok || result.body === undefined) {
        kept.push(entry);
        continue;
      }
      if (isSubplaylistContainer(result.body)) continue;
      kept.push(entry);
    }
    return kept;
  }

  private async importXtream(
    source: Source,
    connection: Record<string, string>,
    importRunId: string,
  ): Promise<ImportMetrics> {
    const url = connection['url'];
    const username = connection['username'];
    const password = connection['password'];
    if (!url || !username || !password) {
      await this.fail(source.id, importRunId, 'MISSING_CREDENTIALS', new Error('Identifiants Xtream manquants'));
      return this.zeros();
    }

    await this.prisma.importRun.update({
      where: { id: importRunId },
      data: { state: 'PARSING' },
    });

    try {
      const { entries } = await fetchXtreamEntries({ url, username, password });
      return await this.ingestEntries(source, entries, importRunId);
    } catch (error) {
      await this.fail(source.id, importRunId, 'CONNECTOR_ERROR', error);
      return this.zeros();
    }
  }

  private async importMacPortal(
    source: Source,
    connection: Record<string, string>,
    importRunId: string,
  ): Promise<ImportMetrics> {
    const url = connection['url'];
    const macAddress = connection['macAddress'];
    if (!url || !macAddress) {
      await this.fail(source.id, importRunId, 'MISSING_CREDENTIALS', new Error('Adresse MAC du portail manquante'));
      return this.zeros();
    }

    await this.prisma.importRun.update({
      where: { id: importRunId },
      data: { state: 'PARSING' },
    });

    try {
      const { entries } = await fetchMacPortalEntries({ url, macAddress });
      return await this.ingestEntries(source, entries, importRunId);
    } catch (error) {
      await this.fail(source.id, importRunId, 'CONNECTOR_ERROR', error);
      return this.zeros();
    }
  }

  private async ingestEntries(
    source: Source,
    entries: ParsedChannel[],
    importRunId: string,
  ): Promise<ImportMetrics> {
    await this.prisma.importRun.update({
      where: { id: importRunId },
      data: { state: 'NORMALIZING' },
    });

    const metrics: ImportMetrics = { read: entries.length, created: 0, updated: 0, duplicates: 0, ignored: 0, errors: 0 };
    const seenKeys = new Set<string>();
    const categoryOrders = new Map<string, number>();

    let position = 0;
    for (const entry of entries) {
      try {
        position += 1;
        const key = slugify(entry.title);
        if (seenKeys.has(key)) {
          metrics.duplicates += 1;
          continue;
        }
        seenKeys.add(key);

        let categoryId: string | null = null;
        if (entry.groupTitle) {
          const categorySlug = slugify(entry.groupTitle);
          if (!categoryOrders.has(categorySlug)) {
            categoryOrders.set(categorySlug, categoryOrders.size);
          }
          const category = await this.prisma.category.upsert({
            where: { slug: categorySlug },
            update: { name: entry.groupTitle },
            create: { slug: categorySlug, name: entry.groupTitle, sortOrder: categoryOrders.get(categorySlug) ?? 0 },
          });
          categoryId = category.id;
        }

        const country = detectCountry(entry.title, entry.groupTitle);

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
              logoKey: entry.tvgLogo ?? null,
              country,
              categoryId,
              sortOrder: position,
            },
          });
          metrics.created += 1;
        } else {
          const data: Prisma.ChannelUpdateInput = { sortOrder: position };
          if (entry.tvgId) data.tvgId = entry.tvgId;
          if (entry.tvgLogo) data.logoKey = entry.tvgLogo;
          if (country) data.country = country;
          if (categoryId) data.category = { connect: { id: categoryId } };
          await this.prisma.channel.update({
            where: { id: existingChannel.id },
            data,
          });
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

  private zeros(): ImportMetrics {
    return { read: 0, created: 0, updated: 0, duplicates: 0, ignored: 0, errors: 0 };
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