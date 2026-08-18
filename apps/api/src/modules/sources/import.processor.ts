import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Source } from '@prisma/client';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { SourceKind } from '@mbolo/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { detectCountry } from '../../common/normalize/country';
import { slugify } from '../../common/normalize/slugify';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JobQueue, QueueJob } from '../../common/queue/queue.interface';
import { StorageService } from '../../common/storage/storage.interface';
import { fetchMacPortalEntries } from './mac-portal.connector';
import { parseM3uStream, type ParsedChannel } from './m3u.parser';
import { SafeFetcher } from './safe-fetcher';
import { fetchXtreamEntries } from './xtream.connector';

interface ImportMetrics { read: number; created: number; updated: number; duplicates: number; ignored: number; errors: number; pruned: number; logos: number; }
interface EntryMeta extends ParsedChannel { key: string; legacyKey: string; country: string | null; categorySlug: string | null; sortOrder: number; }
interface PendingCreate { name: string; canonicalName: string; normalizedKey: string; tvgId: string | null; country: string | null; categorySlug: string | null; sortOrder: number; }
interface PendingUpdate { id: string; sortOrder: number; tvgId?: string; country?: string; categorySlug?: string; }

const BATCH = 5000;
const QUERY_BATCH = 2000;
const LOGO_CONCURRENCY = 6;

class ImportError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const messageOf = (error: unknown): string => error instanceof Error ? error.message : 'Erreur inconnue';

function catalogKey(title: string, country: string | null, group: string | undefined): string {
  const scope = [country, group].filter(Boolean).map((value) => slugify(value as string)).filter(Boolean).join('--');
  const titleKey = slugify(title);
  return scope ? `${titleKey}--${scope}` : titleKey;
}
function legacyKey(title: string): string { return slugify(title); }
function chunks<T>(values: T[], size: number): T[][] { const output: T[][] = []; for (let i = 0; i < values.length; i += size) output.push(values.slice(i, i + size)); return output; }
function isSubplaylistContainer(content: string): boolean {
  if (!content.includes('#EXTM3U') || content.includes('#EXT-X-STREAM-INF')) return false;
  let waiting = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) { waiting = true; continue; }
    if (!line || line.startsWith('#') || !waiting) continue;
    waiting = false;
    if (/\.m3u8?(\?|$)/i.test(line)) return true;
  }
  return false;
}

@Injectable()
export class ImportProcessor implements OnModuleInit {
  private readonly mode: string;
  private readonly probe: boolean;
  private readonly logoTimeout: number;
  private readonly logoMaxBytes: number;
  private readonly logoMaxDownloads: number;
  private readonly logger = new Logger(ImportProcessor.name);

  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly audit: AuditService, private readonly queue: JobQueue, private readonly storage: StorageService, private readonly config: ConfigService) {
    this.mode = this.config.get<string>('QUEUE_DRIVER', 'inprocess');
    this.probe = this.config.get<string>('IMPORT_SUBPLAYLIST_PROBE', 'false') === 'true';
    this.logoTimeout = this.config.get<number>('IMPORT_LOGO_TIMEOUT_MS', 8000);
    this.logoMaxBytes = this.config.get<number>('IMPORT_LOGO_MAX_BYTES', 512000);
    this.logoMaxDownloads = this.config.get<number>('IMPORT_LOGO_MAX_DOWNLOADS', 50000);
  }

  async onModuleInit(): Promise<void> {
    if (this.mode === 'inprocess') await this.queue.process((job) => this.handle(job));
    console.info(`[imports] Processeur ${this.mode} actif`);
  }

  async handle(job: QueueJob): Promise<void> {
    if (job.name !== 'source.import') return;
    const { sourceId, importRunId } = job.payload as { sourceId: string; importRunId: string };
    try { await this.run(sourceId, importRunId); } catch (error) { await this.fail(sourceId, importRunId, 'INTERNAL', error); }
  }

  private async run(sourceId: string, importRunId: string): Promise<void> {
    const [run, source] = await Promise.all([
      this.prisma.importRun.findUnique({ where: { id: importRunId } }),
      this.prisma.source.findUnique({ where: { id: sourceId } }),
    ]);
    if (!run || !source) return;
    if (source.status === 'DISABLED') { await this.fail(sourceId, importRunId, 'SOURCE_DISABLED', new Error('Source désactivée')); return; }
    await this.prisma.importRun.update({ where: { id: importRunId }, data: { state: 'FETCHING', startedAt: new Date() } });
    await this.prisma.source.update({ where: { id: sourceId }, data: { status: 'IMPORTING' } });
    const connection = JSON.parse(this.crypto.decrypt(source.connectionEncrypted)) as Record<string, string>;
    try {
      const metrics = source.kind === 'M3U' ? await this.importM3u(source, connection, importRunId) : source.kind === 'XTREAM' ? await this.importXtream(source, connection, importRunId) : source.kind === 'MAC_PORTAL' ? await this.importMac(source, connection, importRunId) : (() => { throw new ImportError('UNSUPPORTED_KIND', 'Type de source non pris en charge'); })();
      await this.prisma.importRun.update({ where: { id: importRunId }, data: { state: 'COMPLETED', metrics: metrics as unknown as Prisma.InputJsonValue, completedAt: new Date() } });
      await this.prisma.source.update({ where: { id: sourceId }, data: { status: 'READY', lastSyncedAt: new Date() } });
      await this.audit.log(source.ownerId, 'import.completed', 'source', source.id, { importRunId, metrics });
    } catch (error) {
      await this.fail(sourceId, importRunId, error instanceof ImportError ? error.code : 'INTERNAL', error);
    }
  }

  private async importM3u(source: Source, connection: Record<string, string>, importRunId: string): Promise<ImportMetrics> {
    const url = connection.url ?? connection.playlistUrl;
    const fileKey = connection.fileKey;
    const filePath = connection.filePath;
    if (!url && !fileKey && !filePath) throw new ImportError('MISSING_URL', 'URL de playlist ou fichier local manquant');
    await this.prisma.importRun.update({ where: { id: importRunId }, data: { state: 'PARSING' } });
    const maxBytes = this.config.get<number>('IMPORT_MAX_BYTES', 512 * 1024 * 1024);
    let parsed: ParsedChannel[];
    if (fileKey) {
      const stream = await this.storage.getStream(fileKey);
      if (!stream) throw new ImportError('FILE_NOT_FOUND', 'Playlist téléversée introuvable');
      parsed = await parseM3uStream(stream, { maxBytes });
    } else if (filePath) {
      const root = resolve(this.config.get<string>('STORAGE_LOCAL_DIR', './uploads'));
      const absolute = resolve(root, filePath);
      if (!absolute.startsWith(`${root}${sep}`)) throw new ImportError('INVALID_FILE_PATH', 'Chemin de fichier invalide');
      parsed = await parseM3uStream(createReadStream(absolute), { maxBytes });
    } else {
      const result = await new SafeFetcher().fetchStream(url as string, { maxBytes, streamTimeoutMs: this.config.get<number>('IMPORT_FETCH_TIMEOUT_MS', 300000) });
      if (!result.ok || !result.stream) throw new ImportError('FETCH_ERROR', result.error ?? 'Échec de téléchargement');
      parsed = await parseM3uStream(result.stream, { maxBytes });
    }
    if (this.probe) parsed = await this.probeSubplaylists(parsed);
    return this.ingestEntries(source, parsed, importRunId);
  }

  private async probeSubplaylists(entries: ParsedChannel[]): Promise<ParsedChannel[]> {
    const fetcher = new SafeFetcher();
    const kept: ParsedChannel[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= entries.length) return;
        const entry = entries[index];
        const result = await fetcher.fetch(entry.url, { maxBytes: 256 * 1024, timeoutMs: 10000 });
        if (!result.ok || !result.body || !isSubplaylistContainer(result.body)) kept.push(entry);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, Math.max(1, entries.length)) }, () => worker()));
    return kept;
  }

  private async importXtream(source: Source, connection: Record<string, string>, importRunId: string): Promise<ImportMetrics> {
    if (!connection.url || !connection.username || !connection.password) throw new ImportError('MISSING_CREDENTIALS', 'Identifiants Xtream manquants');
    await this.prisma.importRun.update({ where: { id: importRunId }, data: { state: 'PARSING' } });
    try { return this.ingestEntries(source, (await fetchXtreamEntries({ url: connection.url, username: connection.username, password: connection.password })).entries, importRunId); } catch (error) { throw new ImportError('CONNECTOR_ERROR', messageOf(error)); }
  }

  private async importMac(source: Source, connection: Record<string, string>, importRunId: string): Promise<ImportMetrics> {
    if (!connection.url || !connection.macAddress) throw new ImportError('MISSING_CREDENTIALS', 'Adresse MAC du portail manquante');
    await this.prisma.importRun.update({ where: { id: importRunId }, data: { state: 'PARSING' } });
    try { return this.ingestEntries(source, (await fetchMacPortalEntries({ url: connection.url, macAddress: connection.macAddress })).entries, importRunId); } catch (error) { throw new ImportError('CONNECTOR_ERROR', messageOf(error)); }
  }

  private async ingestEntries(source: Source, entries: ParsedChannel[], importRunId: string): Promise<ImportMetrics> {
    await this.prisma.importRun.update({ where: { id: importRunId }, data: { state: 'NORMALIZING' } });
    const metrics: ImportMetrics = { read: entries.length, created: 0, updated: 0, duplicates: 0, ignored: 0, errors: 0, pruned: 0, logos: 0 };
    const metas: EntryMeta[] = [];
    const seenInput = new Set<string>();
    const categorySlugs = new Set<string>();
    const logoUrls = new Map<string, string>();
    for (const [index, entry] of entries.entries()) {
      try {
        const country = detectCountry(entry.title, entry.groupTitle);
        const key = catalogKey(entry.title, country, entry.groupTitle);
        if (seenInput.has(key)) { metrics.duplicates += 1; continue; }
        seenInput.add(key);
        const categorySlug = entry.groupTitle ? slugify(entry.groupTitle) : null;
        if (categorySlug) categorySlugs.add(categorySlug);
        if (entry.tvgLogo && /^https?:\/\//i.test(entry.tvgLogo)) logoUrls.set(key, entry.tvgLogo);
        metas.push({ ...entry, key, legacyKey: legacyKey(entry.title), country, categorySlug, sortOrder: index + 1 });
      } catch { metrics.errors += 1; }
    }

    // Only candidate keys are loaded. The previous implementation loaded the
    // whole catalogue and all variants, which made large imports scale with the
    // database instead of with the playlist.
    const lookupKeys = Array.from(new Set(metas.flatMap((entry) => [entry.key, entry.legacyKey])));
    const existingChannels: Array<{ id: string; name: string; canonicalName: string; normalizedKey: string; tvgId: string | null; country: string | null; categoryId: string | null; sortOrder: number; logoKey: string | null }> = [];
    for (const part of chunks(lookupKeys, QUERY_BATCH)) existingChannels.push(...await this.prisma.channel.findMany({ where: { normalizedKey: { in: part } } }));
    const channelByKey = new Map(existingChannels.map((channel) => [channel.normalizedKey, channel]));
    const categoryBySlug = new Map<string, { id: string; slug: string; name: string; sortOrder: number }>();
    for (const part of chunks(Array.from(categorySlugs), QUERY_BATCH)) {
      const rows = await this.prisma.category.findMany({ where: { slug: { in: part } } });
      for (const row of rows) categoryBySlug.set(row.slug, row);
    }

    const existingIds = existingChannels.map((channel) => channel.id);
    const existingVariants: Array<{ id: string; channelId: string; isActive: boolean; encryptedLocator: Uint8Array }> = [];
    for (const part of chunks(existingIds, QUERY_BATCH)) existingVariants.push(...await this.prisma.streamVariant.findMany({ where: { sourceId: source.id, channelId: { in: part } }, select: { id: true, channelId: true, isActive: true, encryptedLocator: true } }));
    const variantByChannelId = new Map(existingVariants.map((variant) => [variant.channelId, variant]));
    const creates: PendingCreate[] = [];
    const updates: PendingUpdate[] = [];
    const variantUpdates: Array<{ id: string; encryptedLocator: Uint8Array<ArrayBuffer> }> = [];
    const newVariantUrls = new Map<string, string>();
    const seenChannelIds = new Set<string>();

    for (const entry of metas) {
      const existing = channelByKey.get(entry.key) ?? channelByKey.get(entry.legacyKey);
      if (!existing) {
        creates.push({ name: entry.title, canonicalName: entry.title, normalizedKey: entry.key, tvgId: entry.tvgId ?? null, country: entry.country, categorySlug: entry.categorySlug, sortOrder: entry.sortOrder });
        newVariantUrls.set(entry.key, entry.url);
        continue;
      }
      seenChannelIds.add(existing.id);
      const update: PendingUpdate = { id: existing.id, sortOrder: entry.sortOrder };
      let changed = existing.sortOrder !== entry.sortOrder;
      if (entry.tvgId && entry.tvgId !== existing.tvgId) { update.tvgId = entry.tvgId; changed = true; }
      if (entry.country && entry.country !== existing.country) { update.country = entry.country; changed = true; }
      if (entry.categorySlug && categoryBySlug.get(entry.categorySlug)?.id !== existing.categoryId) { update.categorySlug = entry.categorySlug; changed = true; }
      if (changed) updates.push(update);
      const variant = variantByChannelId.get(existing.id);
      if (variant) {
        if (this.crypto.decrypt(variant.encryptedLocator) !== entry.url) variantUpdates.push({ id: variant.id, encryptedLocator: this.crypto.encrypt(entry.url) });
      } else newVariantUrls.set(entry.key, entry.url);
    }

    for (const [index, slug] of Array.from(categorySlugs).entries()) {
      if (!categoryBySlug.has(slug)) categoryBySlug.set(slug, await this.prisma.category.create({ data: { slug, name: slug, sortOrder: index } }));
    }
    for (const part of chunks(creates, BATCH)) {
      await this.prisma.channel.createMany({ data: part.map((entry) => ({ name: entry.name, canonicalName: entry.canonicalName, normalizedKey: entry.normalizedKey, tvgId: entry.tvgId, country: entry.country, categoryId: entry.categorySlug ? categoryBySlug.get(entry.categorySlug)?.id ?? null : null, sortOrder: entry.sortOrder })) });
      const created = await this.prisma.channel.findMany({ where: { normalizedKey: { in: part.map((entry) => entry.normalizedKey) } } });
      for (const channel of created) { channelByKey.set(channel.normalizedKey, channel); seenChannelIds.add(channel.id); }
      metrics.created += created.length;
    }
    metrics.logos = await this.storeChannelLogos(logoUrls, channelByKey);

    const variantsToCreate: Array<{ channelId: string; sourceId: string; encryptedLocator: Uint8Array<ArrayBuffer> }> = [];
    for (const [key, url] of newVariantUrls) { const channel = channelByKey.get(key); if (channel) variantsToCreate.push({ channelId: channel.id, sourceId: source.id, encryptedLocator: this.crypto.encrypt(url) }); else metrics.errors += 1; }
    for (const part of chunks(variantsToCreate, BATCH)) { await this.prisma.streamVariant.createMany({ data: part }); metrics.created += part.length; }

    for (const part of chunks(updates, 1000)) {
      await this.prisma.$transaction(part.map((update) => {
        const data: Prisma.ChannelUpdateInput = { sortOrder: update.sortOrder };
        if (update.tvgId) data.tvgId = update.tvgId;
        if (update.country) data.country = update.country;
        if (update.categorySlug) { const category = categoryBySlug.get(update.categorySlug); if (category) data.category = { connect: { id: category.id } }; }
        return this.prisma.channel.update({ where: { id: update.id }, data });
      }));
    }
    for (const part of chunks(variantUpdates, 1000)) await this.prisma.$transaction(part.map((update) => this.prisma.streamVariant.update({ where: { id: update.id }, data: { encryptedLocator: update.encryptedLocator, isActive: true } })));
    metrics.updated = updates.length + variantUpdates.length;

    const toPrune = existingVariants.filter((variant) => variant.isActive && !seenChannelIds.has(variant.channelId));
    for (const part of chunks(toPrune, 500)) { const result = await this.prisma.streamVariant.updateMany({ where: { id: { in: part.map((variant) => variant.id) } }, data: { isActive: false } }); metrics.pruned += result.count; }
    metrics.ignored = Math.max(0, metrics.read - metrics.created - metrics.updated - metrics.duplicates - metrics.errors);
    return metrics;
  }

  private async storeChannelLogos(logoUrls: Map<string, string>, channels: Map<string, { id: string; logoKey: string | null }>): Promise<number> {
    const unique = Array.from(new Set(logoUrls.values())).slice(0, this.logoMaxDownloads);
    const urlToKey = new Map<string, string>();
    let cursor = 0;
    const worker = async (): Promise<void> => { for (;;) { const index = cursor++; if (index >= unique.length) return; try { const key = await this.storeOneLogo(unique[index]); if (key) urlToKey.set(unique[index], key); } catch { this.logger.warn('Logo ignoré pendant l’import'); } } };
    await Promise.all(Array.from({ length: Math.min(LOGO_CONCURRENCY, Math.max(1, unique.length)) }, () => worker()));
    const updates: Array<{ id: string; logoKey: string }> = [];
    for (const [key, url] of logoUrls) { const channel = channels.get(key); const logoKey = urlToKey.get(url); if (channel && logoKey && channel.logoKey !== logoKey) updates.push({ id: channel.id, logoKey }); }
    for (const part of chunks(updates, 1000)) await this.prisma.$transaction(part.map((update) => this.prisma.channel.update({ where: { id: update.id }, data: { logoKey: update.logoKey } })));
    return urlToKey.size;
  }

  private async storeOneLogo(url: string): Promise<string | null> {
    const result = await new SafeFetcher().fetchStream(url, { maxBytes: this.logoMaxBytes, streamTimeoutMs: this.logoTimeout });
    if (!result.ok || !result.stream || !(result.contentType ?? '').startsWith('image/')) return null;
    const reader = result.stream.getReader(); const chunksOut: Uint8Array[] = []; let bytes = 0;
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > this.logoMaxBytes) { await reader.cancel(); return null; } chunksOut.push(next.value); }
    const buffer = Buffer.concat(chunksOut.map((part) => Buffer.from(part)));
    const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' } as Record<string, string>)[(result.contentType ?? '').split(';')[0]] ?? 'png';
    const key = `logos/${createHash('sha256').update(url).digest('hex').slice(0, 16)}.${extension}`;
    if (!(await this.storage.get(key))) await this.storage.put(key, buffer, result.contentType);
    return key;
  }

  private async fail(sourceId: string, importRunId: string, code: string, error: unknown): Promise<void> {
    const message = messageOf(error).replace(/https?:\/\/[^\s]+/g, '[url masquée]').slice(0, 300);
    await this.prisma.importRun.update({ where: { id: importRunId }, data: { state: 'FAILED', errorCode: code, errorMessage: message, completedAt: new Date() } });
    await this.prisma.source.update({ where: { id: sourceId }, data: { status: 'FAILED' } });
  }
}

export type { SourceKind };
