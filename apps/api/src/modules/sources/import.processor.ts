import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Prisma, type Source } from '@prisma/client';
import type { SourceKind } from '@mbolo/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { slugify } from '../../common/normalize/slugify';
import { detectCountry } from '../../common/normalize/country';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JobQueue, QueueJob } from '../../common/queue/queue.interface';
import { StorageService } from '../../common/storage/storage.interface';
import { parseM3uStream, type ParsedChannel } from './m3u.parser';
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
  pruned: number;
  logos: number;
}

// Concurrence bornée des téléchargements de logos : ne pas saturer ni les
// fournisseurs ni le process (le téléchargement est IO-bound, 6 suffit).
const LOGO_DOWNLOAD_CONCURRENCY = 6;

class ImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Erreur inconnue';
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
  private readonly logoTimeoutMs: number;
  private readonly logoMaxBytes: number;
  private readonly logoMaxDownloads: number;
  private readonly logger = new Logger(ImportProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly queue: JobQueue,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {
    this.mode = this.config.get<string>('QUEUE_DRIVER', 'inprocess');
    this.probeSubplaylists =
      this.config.get<string>('IMPORT_SUBPLAYLIST_PROBE', 'false') === 'true';
    this.logoTimeoutMs = this.config.get<number>('IMPORT_LOGO_TIMEOUT_MS', 8_000);
    this.logoMaxBytes = this.config.get<number>('IMPORT_LOGO_MAX_BYTES', 512_000);
    this.logoMaxDownloads = this.config.get<number>('IMPORT_LOGO_MAX_DOWNLOADS', 50_000);
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
    try {
      if (source.kind === 'M3U') {
        metrics = await this.importM3u(source, connection, importRunId);
      } else if (source.kind === 'XTREAM') {
        metrics = await this.importXtream(source, connection, importRunId);
      } else if (source.kind === 'MAC_PORTAL') {
        metrics = await this.importMacPortal(source, connection, importRunId);
      } else {
        throw new ImportError('UNSUPPORTED_KIND', 'Type de source non pris en charge');
      }
    } catch (error) {
      // Un échec de connexion/parse ne doit pas aboutir à un run COMPLETED :
      // l'import est marqué FAILED et la source passe en FAILED.
      const code = error instanceof ImportError ? error.code : 'INTERNAL';
      await this.fail(sourceId, importRunId, code, error);
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
    const filePath = connection['filePath'];
    if (!url && !filePath) {
      throw new ImportError('MISSING_URL', 'URL de playlist ou fichier local manquant');
    }

    await this.prisma.importRun.update({
      where: { id: importRunId },
      data: { state: 'PARSING' },
    });

    const maxBytes = this.config.get<number>('IMPORT_MAX_BYTES', 512 * 1024 * 1024);

    // Playlist téléversée depuis la console : lecture locale en streaming,
    // jamais de buffer entier en mémoire (mêmes garanties que l'URL).
    if (filePath) {
      const root = resolve(this.config.get<string>('STORAGE_LOCAL_DIR', './uploads'));
      const absolute = resolve(root, filePath);
      if (!absolute.startsWith(`${root}${sep}`)) {
        throw new ImportError('INVALID_FILE_PATH', 'Chemin de fichier invalide');
      }
      const parsed = await parseM3uStream(createReadStream(absolute), { maxBytes });
      const entries = this.probeSubplaylists ? await this.probeSubplaylistEntries(parsed) : parsed;
      return this.ingestEntries(source, entries, importRunId);
    }

    const fetcher = new SafeFetcher();
    // Certaines playlists M3U dépassent largement 20 Mo (ex. 150 Mo+ chez
    // certains fournisseurs) : la limite est configurable (IMPORT_MAX_BYTES).
    // Les gros playlists (100 Mo+) arrivent lentement chez certains fournisseurs :
    // le timeout par défaut laisse une marge (téléchargement 155 Mo ≈ 35-120 s).
    const timeoutMs = this.config.get<number>('IMPORT_FETCH_TIMEOUT_MS', 300_000);
    // Téléchargement et parse en streaming : jamais de buffer entier en mémoire
    // (un playlist 150 Mo bufferisé + split ferait exploser le heap Node).
    const result = await fetcher.fetchStream(url, { maxBytes, streamTimeoutMs: timeoutMs });
    if (!result.ok || result.stream === undefined) {
      throw new ImportError('FETCH_ERROR', result.error ?? 'Échec de téléchargement');
    }

    const parsed = await parseM3uStream(result.stream, { maxBytes });
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
      throw new ImportError('MISSING_CREDENTIALS', 'Identifiants Xtream manquants');
    }

    await this.prisma.importRun.update({
      where: { id: importRunId },
      data: { state: 'PARSING' },
    });

    try {
      const { entries } = await fetchXtreamEntries({ url, username, password });
      return this.ingestEntries(source, entries, importRunId);
    } catch (error) {
      throw new ImportError('CONNECTOR_ERROR', errorMessage(error));
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
      throw new ImportError('MISSING_CREDENTIALS', 'Adresse MAC du portail manquante');
    }

    await this.prisma.importRun.update({
      where: { id: importRunId },
      data: { state: 'PARSING' },
    });

    try {
      const { entries } = await fetchMacPortalEntries({ url, macAddress });
      return this.ingestEntries(source, entries, importRunId);
    } catch (error) {
      throw new ImportError('CONNECTOR_ERROR', errorMessage(error));
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

    const metrics: ImportMetrics = { read: entries.length, created: 0, updated: 0, duplicates: 0, ignored: 0, errors: 0, pruned: 0, logos: 0 };

    // Préchargement en 3 requêtes au lieu d'une requête par entrée.
    const [existingChannels, existingCategories, existingVariants] = await Promise.all([
      this.prisma.channel.findMany(),
      this.prisma.category.findMany(),
      this.prisma.streamVariant.findMany({ where: { sourceId: source.id } }),
    ]);
    const channelByKey = new Map(existingChannels.map((c) => [c.normalizedKey, c]));
    const categoryBySlug = new Map(existingCategories.map((c) => [c.slug, c]));
    const variantByChannelId = new Map(existingVariants.map((v) => [v.channelId, v]));

    const seenKeys = new Set<string>();
    const categoryOrders = new Map<string, number>();
    const newCategorySlugs: string[] = [];
    // Logos à télécharger : URL fournisseur -> chaînes. On ne stocke JAMAIS
    // l'URL brute en base (elle fuit le fournisseur vers le navigateur et est
    // bloquée par l'ORB) : le logo est rapatrié dans le storage local/S3.
    const logoUrlsByKey = new Map<string, string>();

    interface PendingCreate {
      name: string;
      canonicalName: string;
      normalizedKey: string;
      tvgId: string | null;
      country: string | null;
      categorySlug: string | null;
      sortOrder: number;
    }
    interface PendingUpdate {
      id: string;
      sortOrder: number;
      tvgId?: string;
      country?: string;
      categorySlug?: string;
    }

    const channelCreates: PendingCreate[] = [];
    const channelUpdates: PendingUpdate[] = [];
    const newVariantsByKey = new Map<string, string>();
    const variantUpdates: { id: string; encryptedLocator: Uint8Array<ArrayBuffer> }[] = [];

    let position = 0;
    for (const entry of entries) {
      try {
        position += 1;
        // Progression visible pendant le NORMALIZING : l'UI console peut
        // afficher un pourcentage via les métriques de l'ImportRun.
        if (position % 2_000 === 0) {
          await this.prisma.importRun.update({
            where: { id: importRunId },
            data: {
              metrics: {
                phase: 'NORMALIZING',
                processed: position,
                total: entries.length,
              } as unknown as Prisma.InputJsonValue,
            },
          });
        }
        const key = slugify(entry.title);
        if (seenKeys.has(key)) {
          metrics.duplicates += 1;
          continue;
        }
        seenKeys.add(key);

        let categorySlug: string | null = null;
        if (entry.groupTitle) {
          const slug = slugify(entry.groupTitle);
          categorySlug = slug;
          if (!categoryOrders.has(slug)) {
            categoryOrders.set(slug, categoryOrders.size);
            if (!categoryBySlug.has(slug)) newCategorySlugs.push(slug);
          }
        }

        const country = detectCountry(entry.title, entry.groupTitle);

        // Logo distant : téléchargé plus tard (storeChannelLogos). Une URL
        // brute n'est jamais écrite en base.
        if (entry.tvgLogo && /^https?:\/\//i.test(entry.tvgLogo)) {
          logoUrlsByKey.set(key, entry.tvgLogo);
        }

        const existingChannel = channelByKey.get(key);
        if (!existingChannel) {
          channelCreates.push({
            name: entry.title,
            canonicalName: entry.title,
            normalizedKey: key,
            tvgId: entry.tvgId ?? null,
            country,
            categorySlug,
            sortOrder: position,
          });
        } else {
          // Aucune écriture si rien n'a changé : réimporter une grosse playlist
          // ne doit pas réécrire des centaines de milliers de lignes identiques.
          const update: PendingUpdate = { id: existingChannel.id, sortOrder: position };
          let changed = position !== existingChannel.sortOrder;
          if (entry.tvgId && entry.tvgId !== existingChannel.tvgId) {
            update.tvgId = entry.tvgId;
            changed = true;
          }
          if (country && country !== existingChannel.country) {
            update.country = country;
            changed = true;
          }
          if (categorySlug) {
            const resolvedCategoryId = categoryBySlug.get(categorySlug)?.id ?? null;
            if (resolvedCategoryId !== existingChannel.categoryId) {
              update.categorySlug = categorySlug;
              changed = true;
            }
          }
          if (changed) channelUpdates.push(update);
        }

        const existingVariant = existingChannel ? variantByChannelId.get(existingChannel.id) : undefined;
        if (existingVariant) {
          // Comparaison du locator déchiffré : pas de réécriture si inchangé.
          let same = true;
          try {
            same = this.crypto.decrypt(existingVariant.encryptedLocator) === entry.url;
          } catch {
            same = false;
          }
          if (!same) {
            variantUpdates.push({ id: existingVariant.id, encryptedLocator: this.crypto.encrypt(entry.url) });
          }
        } else {
          newVariantsByKey.set(key, entry.url);
        }
      } catch {
        metrics.errors += 1;
      }
    }

    // Catégories manquantes, créées en un seul lot.
    for (const [index, slug] of newCategorySlugs.entries()) {
      categoryBySlug.set(
        slug,
        await this.prisma.category.create({
          data: { slug, name: slug, sortOrder: categoryOrders.get(slug) ?? existingCategories.length + index },
        }),
      );
    }

    // Chaînes manquantes, créées par lots (un statement SQL géant avec des
    // centaines de milliers de lignes fait exploser la mémoire ET bloque SQLite).
    if (channelCreates.length > 0) {
      const chunkSize = 5_000;
      for (let i = 0; i < channelCreates.length; i += chunkSize) {
        const chunk = channelCreates.slice(i, i + chunkSize);
        await this.prisma.channel.createMany({
data: chunk.map((c) => ({
            name: c.name,
            canonicalName: c.canonicalName,
            normalizedKey: c.normalizedKey,
            tvgId: c.tvgId,
            country: c.country,
            categoryId: c.categorySlug ? (categoryBySlug.get(c.categorySlug)?.id ?? null) : null,
            sortOrder: c.sortOrder,
          })),
        });
      }
      const createdKeys = channelCreates.map((c) => c.normalizedKey);
      const readChunkSize = 10_000;
      for (let i = 0; i < createdKeys.length; i += readChunkSize) {
        const keys = createdKeys.slice(i, i + readChunkSize);
        const created = await this.prisma.channel.findMany({
          where: { normalizedKey: { in: keys } },
        });
        for (const channel of created) channelByKey.set(channel.normalizedKey, channel);
        metrics.created += created.length;
      }
      // Libération mémoire : les données brutes ne servent plus.
      channelCreates.length = 0;
    }

    // Logos : téléchargés (storage local/S3) après création des chaînes, car
    // les IDs des nouvelles chaînes ne sont connus qu'après le createMany.
    metrics.logos = await this.storeChannelLogos(logoUrlsByKey, channelByKey);

    // Variantes manquantes, créées par lots (mémoire + verrous SQLite).
    if (newVariantsByKey.size > 0) {
      const variants: { channelId: string; sourceId: string; encryptedLocator: Uint8Array<ArrayBuffer> }[] = [];
      for (const [key, url] of newVariantsByKey) {
        const channel = channelByKey.get(key);
        if (!channel) {
          metrics.errors += 1;
          continue;
        }
        variants.push({ channelId: channel.id, sourceId: source.id, encryptedLocator: this.crypto.encrypt(url) });
      }
      const chunkSize = 5_000;
      for (let i = 0; i < variants.length; i += chunkSize) {
        await this.prisma.streamVariant.createMany({ data: variants.slice(i, i + chunkSize) });
      }
      metrics.created += variants.length;
      variants.length = 0;
      newVariantsByKey.clear();
    }

    // Mises à jour (chaînes + variantes) par lots de transactions : un seul
    // $transaction avec des centaines de milliers d'opérations fait OOM.
    if (channelUpdates.length > 0 || variantUpdates.length > 0) {
      const ops: Prisma.PrismaPromise<unknown>[] = [];
      const flush = async (): Promise<void> => {
        if (ops.length === 0) return;
        await this.prisma.$transaction(ops.splice(0));
      };
      for (const update of channelUpdates) {
        const data: Prisma.ChannelUpdateInput = { sortOrder: update.sortOrder };
        if (update.tvgId) data.tvgId = update.tvgId;
        if (update.country) data.country = update.country;
        if (update.categorySlug) {
          const category = categoryBySlug.get(update.categorySlug);
          if (category) data.category = { connect: { id: category.id } };
        }
        ops.push(this.prisma.channel.update({ where: { id: update.id }, data }));
        if (ops.length >= 1_000) await flush();
      }
      for (const update of variantUpdates) {
        ops.push(
          this.prisma.streamVariant.update({
            where: { id: update.id },
            data: { encryptedLocator: update.encryptedLocator, isActive: true },
          }),
        );
        if (ops.length >= 1_000) await flush();
      }
      await flush();
      metrics.updated += variantUpdates.length;
      channelUpdates.length = 0;
      variantUpdates.length = 0;
    }

    // Élagage : désactive les variantes de cette source dont la chaîne n'est plus
    // présente dans la playlist. Garde de sécurité : on n'élague pas si la playlist
    // importée est vide (une API qui renvoie [] ne doit pas vider la source).
    if (entries.length > 0) {
      const seenChannelIds = new Set<string>();
      for (const key of seenKeys) {
        const channel = channelByKey.get(key);
        if (channel) seenChannelIds.add(channel.id);
      }
      const toPrune = existingVariants.filter((variant) => variant.isActive && !seenChannelIds.has(variant.channelId));
      for (let i = 0; i < toPrune.length; i += 500) {
        const chunk = toPrune.slice(i, i + 500);
        const result = await this.prisma.streamVariant.updateMany({
          where: { id: { in: chunk.map((variant) => variant.id) } },
          data: { isActive: false },
        });
        metrics.pruned += result.count;
      }
    }

    metrics.ignored = Math.max(0, metrics.read - metrics.created - metrics.updated - metrics.duplicates - metrics.errors);
    return metrics;
  }

  /**
   * Rapatrie les logos dans le storage (local/S3) : une seule requête par URL
   * unique (dédoublonnage), concurrence bornée, échecs silencieux. Les URLs
   * fournisseur ne sont jamais persistées ni exposées au navigateur.
   */
  private async storeChannelLogos(
    logoUrlsByKey: Map<string, string>,
    channelByKey: Map<string, { id: string; logoKey: string | null }>,
  ): Promise<number> {
    if (logoUrlsByKey.size === 0) return 0;

    const uniqueUrls = Array.from(new Set(logoUrlsByKey.values()));
    if (uniqueUrls.length > this.logoMaxDownloads) {
      this.logger.warn(
        `Import de logos tronqué: ${uniqueUrls.length} URLs uniques, plafond ${this.logoMaxDownloads}`,
      );
      uniqueUrls.length = this.logoMaxDownloads;
    }

    const fetcher = new SafeFetcher();
    const urlToKey = new Map<string, string>();
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= uniqueUrls.length) return;
        try {
          const key = await this.storeOneLogo(fetcher, uniqueUrls[index]);
          if (key) urlToKey.set(uniqueUrls[index], key);
        } catch {
          // Logo injoignable ou invalide : la chaîne reste sans logo.
        }
      }
    };
    await Promise.all(Array.from({ length: LOGO_DOWNLOAD_CONCURRENCY }, () => worker()));

    const updates: { id: string; logoKey: string }[] = [];
    for (const [key, url] of logoUrlsByKey) {
      const channel = channelByKey.get(key);
      const storageKey = urlToKey.get(url);
      if (!channel || !storageKey || channel.logoKey === storageKey) continue;
      updates.push({ id: channel.id, logoKey: storageKey });
    }
    for (let i = 0; i < updates.length; i += 1_000) {
      const chunk = updates.slice(i, i + 1_000);
      await this.prisma.$transaction(
        chunk.map((update) =>
          this.prisma.channel.update({
            where: { id: update.id },
            data: { logoKey: update.logoKey },
          }),
        ),
      );
    }
    return urlToKey.size;
  }

  private async storeOneLogo(fetcher: SafeFetcher, url: string): Promise<string | null> {
    // fetchStream (octets bruts) : fetch() convertit en UTF-8 et corromprait
    // les images binaires.
    const result = await fetcher.fetchStream(url, {
      maxBytes: this.logoMaxBytes,
      streamTimeoutMs: this.logoTimeoutMs,
    });
    if (!result.ok || result.stream === undefined) return null;
    // Filtre ORB : on ne stocke que de vraies réponses image, jamais une page
    // HTML d'erreur ou du JSON renvoyé par un fournisseur capricieux.
    if (!(result.contentType ?? '').startsWith('image/')) return null;

    const buffer = await collectStream(result.stream, this.logoMaxBytes);
    if (!buffer) return null;

    const extension = imageExtension(result.contentType) ?? 'png';
    const key = `logos/${createHash('sha256').update(url).digest('hex').slice(0, 16)}.${extension}`;
    // Déjà téléchargé lors d'un import précédent : on réutilise.
    if (await this.storage.get(key)) return key;
    await this.storage.put(key, buffer, result.contentType);
    return key;
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

function collectStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Buffer | null> {
  return (async () => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  })();
}

function imageExtension(contentType: string | null | undefined): string | null {
  switch ((contentType ?? '').toLowerCase().split(';')[0]?.trim()) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/svg+xml':
      return 'svg';
    case 'image/x-icon':
    case 'image/vnd.microsoft.icon':
      return 'ico';
    default:
      return null;
  }
}