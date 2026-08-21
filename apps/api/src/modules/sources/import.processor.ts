import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { parseM3uStreamBatched, type ParsedChannel } from './m3u.parser';
import { ImportCancellationRegistry } from './import-cancellation';
import { SafeFetcher } from './safe-fetcher';
import { fetchXtreamEntries } from './xtream.connector';
import { EpgImportService } from '../epg/epg-import.service';

interface ImportSource { id: string; ownerId: string; kind: string; status: string; connectionEncrypted: Uint8Array; }
interface ExistingChannel { id: string; name: string; canonicalName: string; normalizedKey: string; tvgId: string | null; country: string | null; categoryId: string | null; sortOrder: number; logoKey: string | null; }
interface ImportMetrics { read: number; processed: number; created: number; updated: number; duplicates: number; ignored: number; errors: number; pruned: number; logos: number; }
interface EntryMeta extends ParsedChannel { key: string; legacyKey: string; country: string | null; categorySlug: string | null; sortOrder: number; }
interface PendingCreate { name: string; canonicalName: string; normalizedKey: string; tvgId: string | null; country: string | null; categorySlug: string | null; sortOrder: number; }
interface PendingUpdate { id: string; sortOrder: number; tvgId?: string; country?: string; categorySlug?: string; }
interface ImportState { metrics: ImportMetrics; seenInput: Set<string>; seenChannelIds: Set<string>; }

const BATCH = 5000;
const QUERY_BATCH = 2000;
const LOGO_CONCURRENCY = 6;
const ACTIVE_IMPORT_STATES = new Set(['QUEUED', 'FETCHING', 'PARSING', 'NORMALIZING']);

class ImportError extends Error { constructor(readonly code: string, message: string) { super(message); } }
class ImportCanceled extends Error { constructor() { super('Import annulé'); } }
const messageOf = (error: unknown): string => error instanceof Error ? error.message : 'Erreur inconnue';
function catalogKey(title: string, country: string | null, group: string | undefined): string { const scope = [country, group].filter(Boolean).map((value) => slugify(value as string)).filter(Boolean).join('--'); const titleKey = slugify(title); return scope ? `${titleKey}--${scope}` : titleKey; }
function legacyKey(title: string): string { return slugify(title); }
function chunks<T>(values: T[], size: number): T[][] { const output: T[][] = []; for (let i = 0; i < values.length; i += size) output.push(values.slice(i, i + size)); return output; }
function isSubplaylistContainer(content: string): boolean { if (!content.includes('#EXTM3U') || content.includes('#EXT-X-STREAM-INF')) return false; let waiting = false; for (const raw of content.split(/\r?\n/)) { const line = raw.trim(); if (line.startsWith('#EXTINF:')) { waiting = true; continue; } if (!line || line.startsWith('#') || !waiting) continue; waiting = false; if (/\.m3u8?(\?|$)/i.test(line)) return true; } return false; }

@Injectable()
export class ImportProcessor implements OnModuleInit {
  private readonly mode: string; private readonly probe: boolean; private readonly logoTimeout: number; private readonly logoMaxBytes: number; private readonly logoMaxDownloads: number; private readonly logger = new Logger(ImportProcessor.name);
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly audit: AuditService, private readonly queue: JobQueue, private readonly storage: StorageService, private readonly config: ConfigService, private readonly cancellation: ImportCancellationRegistry, private readonly epgImport: EpgImportService) { this.mode = this.config.get<string>('QUEUE_DRIVER', 'inprocess'); this.probe = this.config.get<string>('IMPORT_SUBPLAYLIST_PROBE', 'false') === 'true'; this.logoTimeout = this.config.get<number>('IMPORT_LOGO_TIMEOUT_MS', 8000); this.logoMaxBytes = this.config.get<number>('IMPORT_LOGO_MAX_BYTES', 512000); this.logoMaxDownloads = this.config.get<number>('IMPORT_LOGO_MAX_DOWNLOADS', 50000); }
  async onModuleInit(): Promise<void> { if (this.mode === 'inprocess') await this.queue.process((job) => this.handle(job)); console.info(`[imports] Processeur ${this.mode} actif`); }
  async handle(job: QueueJob): Promise<void> { if (job.name !== 'source.import') return; const { sourceId, importRunId } = job.payload as { sourceId: string; importRunId: string }; try { await this.run(sourceId, importRunId); } catch (error) { await this.fail(sourceId, importRunId, 'INTERNAL', error); } }

  private async run(sourceId: string, importRunId: string): Promise<void> {
    const run = await this.prisma.importRun.findUnique({ where: { id: importRunId } }) as { state: string } | null;
    const source = await this.prisma.source.findUnique({ where: { id: sourceId } }) as ImportSource | null;
    if (!run || !source || run.state === 'CANCELED') return;
    if (source.status === 'DISABLED') { await this.fail(sourceId, importRunId, 'SOURCE_DISABLED', new Error('Source désactivée')); return; }
    await this.prisma.importRun.update({ where: { id: importRunId }, data: { state: 'FETCHING', startedAt: new Date() } });
    await this.prisma.source.update({ where: { id: sourceId }, data: { status: 'IMPORTING' } });
    this.cancellation.register(importRunId);
    const connection = JSON.parse(this.crypto.decrypt(source.connectionEncrypted)) as Record<string, string>;
    try {
      await this.assertNotCanceled(importRunId);
      const metrics = source.kind === 'M3U' ? await this.importM3u(source, connection, importRunId) : source.kind === 'XTREAM' ? await this.importXtream(source, connection, importRunId) : source.kind === 'MAC_PORTAL' ? await this.importMac(source, connection, importRunId) : (() => { throw new ImportError('UNSUPPORTED_KIND', 'Type de source non pris en charge'); })();
      const completed = await this.prisma.importRun.updateMany({ where: { id: importRunId, state: { not: 'CANCELED' } }, data: { state: 'COMPLETED', metrics: JSON.parse(JSON.stringify(metrics)), completedAt: new Date() } });
      if (!completed.count) return;
      await this.prisma.source.update({ where: { id: sourceId }, data: { status: 'READY', lastSyncedAt: new Date() } });
      await this.audit.log(source.ownerId, 'import.completed', 'source', source.id, { importRunId, metrics });
      void this.epgImport.runForSource(source.id).catch((error) => this.logger.warn(`EPG auto non déclenché pour ${source.id}: ${String(error)}`));
    } catch (error) { if (error instanceof ImportCanceled || await this.isCanceled(importRunId)) return; await this.fail(sourceId, importRunId, error instanceof ImportError ? error.code : 'INTERNAL', error); }
    finally { this.cancellation.unregister(importRunId); }
  }

  private createImportState(): ImportState { return { metrics: { read: 0, processed: 0, created: 0, updated: 0, duplicates: 0, ignored: 0, errors: 0, pruned: 0, logos: 0 }, seenInput: new Set<string>(), seenChannelIds: new Set<string>() }; }
  private async importM3u(source: ImportSource, connection: Record<string, string>, importRunId: string): Promise<ImportMetrics> {
    const url = connection.url ?? connection.playlistUrl; const fileKey = connection.fileKey; const filePath = connection.filePath; if (!url && !fileKey && !filePath) throw new ImportError('MISSING_URL', 'URL de playlist ou fichier local manquant');
    await this.prisma.importRun.update({ where: { id: importRunId }, data: { state: 'PARSING' } }); const maxBytes = this.config.get<number>('IMPORT_MAX_BYTES', 512 * 1024 * 1024); let stream: NodeJS.ReadableStream;
    if (fileKey) { const stored = await this.storage.getStream(fileKey); if (!stored) throw new ImportError('FILE_NOT_FOUND', 'Playlist téléversée introuvable'); stream = stored; }
    else if (filePath) { const root = resolve(this.config.get<string>('STORAGE_LOCAL_DIR', './uploads')); const absolute = resolve(root, filePath); if (!absolute.startsWith(`${root}${sep}`)) throw new ImportError('INVALID_FILE_PATH', 'Chemin de fichier invalide'); stream = createReadStream(absolute); }
    else { const result = await new SafeFetcher().fetchStream(url as string, { maxBytes, streamTimeoutMs: this.config.get<number>('IMPORT_FETCH_TIMEOUT_MS', 300000), signal: this.cancellation.signal(importRunId) }); if (!result.ok || !result.stream) throw new ImportError('FETCH_ERROR', result.error ?? 'Échec de téléchargement'); stream = result.stream as unknown as NodeJS.ReadableStream; }
    const state = this.createImportState();
    await parseM3uStreamBatched(stream as import('node:stream').Readable, { maxBytes, batchSize: BATCH, onBatch: async (batch) => { await this.assertNotCanceled(importRunId); const entries = this.probe ? await this.probeSubplaylists(batch, importRunId) : batch; await this.ingestEntries(source, entries, importRunId, state, false); } });
    await this.assertNotCanceled(importRunId); return this.finalizeIngest(source, importRunId, state);
  }
  private async probeSubplaylists(entries: ParsedChannel[], importRunId: string): Promise<ParsedChannel[]> { const fetcher = new SafeFetcher(); const results: Array<ParsedChannel | null> = new Array(entries.length).fill(null); let cursor = 0; const worker = async (): Promise<void> => { for (;;) { const index = cursor++; if (index >= entries.length) return; await this.assertNotCanceled(importRunId); const result = await fetcher.fetch(entries[index].url, { maxBytes: 256 * 1024, timeoutMs: 10000, signal: this.cancellation.signal(importRunId) }); if (!result.ok || !result.body || !isSubplaylistContainer(result.body)) results[index] = entries[index]; } }; await Promise.all(Array.from({ length: Math.min(8, Math.max(1, entries.length)) }, () => worker())); return results.filter((entry): entry is ParsedChannel => entry !== null); }
  private async importXtream(source: ImportSource, connection: Record<string, string>, importRunId: string): Promise<ImportMetrics> { if (!connection.url || !connection.username || !connection.password) throw new ImportError('MISSING_CREDENTIALS', 'Identifiants Xtream manquants'); await this.prisma.importRun.update({ where: { id: importRunId }, data: { state: 'PARSING' } }); try { const state = this.createImportState(); return this.ingestEntries(source, (await fetchXtreamEntries({ url: connection.url, username: connection.username, password: connection.password })).entries, importRunId, state, true); } catch (error) { throw new ImportError('CONNECTOR_ERROR', messageOf(error)); } }
  private async importMac(source: ImportSource, connection: Record<string, string>, importRunId: string): Promise<ImportMetrics> { const url = connection.url ?? connection.portal; const macAddress = connection.macAddress ?? connection.mac ?? connection.mac_address; if (!url || !macAddress) throw new ImportError('MISSING_CREDENTIALS', 'Adresse MAC du portail manquante'); await this.prisma.importRun.update({ where: { id: importRunId }, data: { state: 'PARSING' } }); try { const state = this.createImportState(); return this.ingestEntries(source, (await fetchMacPortalEntries({ url, macAddress, signal: this.cancellation.signal(importRunId) })).entries, importRunId, state, true); } catch (error) { throw new ImportError('CONNECTOR_ERROR', messageOf(error)); } }

  private async ingestEntries(source: ImportSource, entries: ParsedChannel[], importRunId: string, state: ImportState, finalize: boolean): Promise<ImportMetrics> {
    await this.assertNotCanceled(importRunId); const metrics = state.metrics; await this.prisma.importRun.update({ where: { id: importRunId }, data: { state: 'NORMALIZING' } }); metrics.read += entries.length; const metas: EntryMeta[] = []; const categorySlugs = new Set<string>(); const categoryNameBySlug = new Map<string, string>(); const logoUrls = new Map<string, string>();
    for (const [index, entry] of entries.entries()) { try { const country = detectCountry(entry.title, entry.groupTitle); const key = catalogKey(entry.title, country, entry.groupTitle); if (state.seenInput.has(key)) { metrics.duplicates += 1; continue; } state.seenInput.add(key); const categorySlug = entry.groupTitle ? slugify(entry.groupTitle) : null; if (categorySlug) { categorySlugs.add(categorySlug); if (!categoryNameBySlug.has(categorySlug) && entry.groupTitle) categoryNameBySlug.set(categorySlug, entry.groupTitle); } if (entry.tvgLogo && /^https?:\/\//i.test(entry.tvgLogo)) logoUrls.set(key, entry.tvgLogo); metas.push({ ...entry, key, legacyKey: legacyKey(entry.title), country, categorySlug, sortOrder: metrics.read - entries.length + index + 1 }); } catch { metrics.errors += 1; } }
    const lookupKeys = Array.from(new Set(metas.flatMap((entry: EntryMeta) => [entry.key, entry.legacyKey]))); const existingChannels: ExistingChannel[] = [];
    for (const part of chunks(lookupKeys, QUERY_BATCH)) { const rows = await this.prisma.channel.findMany({ where: { normalizedKey: { in: part } } }) as ExistingChannel[]; existingChannels.push(...rows); }
    const channelByKey = new Map<string, ExistingChannel>(existingChannels.map((channel: ExistingChannel) => [channel.normalizedKey, channel])); const categoryBySlug = new Map<string, { id: string; slug: string; name: string; sortOrder: number }>();
    for (const part of chunks(Array.from(categorySlugs), QUERY_BATCH)) { const rows = await this.prisma.category.findMany({ where: { slug: { in: part } } }) as Array<{ id: string; slug: string; name: string; sortOrder: number }>; for (const row of rows) categoryBySlug.set(row.slug, row); }
    const existingIds = existingChannels.map((channel: ExistingChannel) => channel.id); const existingVariants: Array<{ id: string; channelId: string; isActive: boolean; encryptedLocator: Uint8Array }> = [];
    for (const part of chunks(existingIds, QUERY_BATCH)) { const rows = await this.prisma.streamVariant.findMany({ where: { sourceId: source.id, channelId: { in: part } }, select: { id: true, channelId: true, isActive: true, encryptedLocator: true } }) as Array<{ id: string; channelId: string; isActive: boolean; encryptedLocator: Uint8Array }>; existingVariants.push(...rows); }
    const variantByChannelId = new Map(existingVariants.map((variant) => [variant.channelId, variant])); const creates: PendingCreate[] = []; const updates: PendingUpdate[] = []; const variantUpdates: Array<{ id: string; encryptedLocator: Uint8Array<ArrayBuffer> }> = []; const newVariantUrls = new Map<string, string>();
    for (const entry of metas) { const existing = channelByKey.get(entry.key) ?? channelByKey.get(entry.legacyKey); if (!existing) { creates.push({ name: entry.title, canonicalName: entry.title, normalizedKey: entry.key, tvgId: entry.tvgId ?? null, country: entry.country, categorySlug: entry.categorySlug, sortOrder: entry.sortOrder }); newVariantUrls.set(entry.key, entry.url); continue; } channelByKey.set(entry.key, existing); channelByKey.set(entry.legacyKey, existing); state.seenChannelIds.add(existing.id); const update: PendingUpdate = { id: existing.id, sortOrder: entry.sortOrder }; let changed = existing.sortOrder !== entry.sortOrder; if (entry.tvgId && entry.tvgId !== existing.tvgId) { update.tvgId = entry.tvgId; changed = true; } if (entry.country && entry.country !== existing.country) { update.country = entry.country; changed = true; } if (entry.categorySlug && categoryBySlug.get(entry.categorySlug)?.id !== existing.categoryId) { update.categorySlug = entry.categorySlug; changed = true; } if (changed) updates.push(update); const variant = variantByChannelId.get(existing.id); if (variant) { if (this.crypto.decrypt(variant.encryptedLocator) !== entry.url) variantUpdates.push({ id: variant.id, encryptedLocator: this.crypto.encrypt(entry.url) }); } else newVariantUrls.set(entry.key, entry.url); }
    for (const [index, slug] of Array.from(categorySlugs).entries()) if (!categoryBySlug.has(slug)) categoryBySlug.set(slug, await this.prisma.category.create({ data: { slug, name: categoryNameBySlug.get(slug) ?? slug, sortOrder: index } }));
    for (const part of chunks(creates, BATCH)) { await this.prisma.channel.createMany({ data: part.map((entry: PendingCreate) => ({ name: entry.name, canonicalName: entry.canonicalName, normalizedKey: entry.normalizedKey, tvgId: entry.tvgId, country: entry.country, categoryId: entry.categorySlug ? categoryBySlug.get(entry.categorySlug)?.id ?? null : null, sortOrder: entry.sortOrder })) }); const created = await this.prisma.channel.findMany({ where: { normalizedKey: { in: part.map((entry: PendingCreate) => entry.normalizedKey) } } }) as ExistingChannel[]; for (const channel of created) { channelByKey.set(channel.normalizedKey, channel); state.seenChannelIds.add(channel.id); } metrics.created += created.length; }
    metrics.logos += await this.storeChannelLogos(logoUrls, channelByKey); const variantsToCreate: Array<{ channelId: string; sourceId: string; encryptedLocator: Uint8Array<ArrayBuffer> }> = [];
    for (const [key, url] of newVariantUrls) { const channel = channelByKey.get(key); if (channel) variantsToCreate.push({ channelId: channel.id, sourceId: source.id, encryptedLocator: this.crypto.encrypt(url) }); else metrics.errors += 1; }
    for (const part of chunks(variantsToCreate, BATCH)) { await this.prisma.streamVariant.createMany({ data: part }); metrics.created += part.length; }
    for (const part of chunks(updates, 1000)) await this.prisma.$transaction(part.map((update: PendingUpdate) => { const data = { sortOrder: update.sortOrder, ...(update.tvgId ? { tvgId: update.tvgId } : {}), ...(update.country ? { country: update.country } : {}), ...(update.categorySlug && categoryBySlug.get(update.categorySlug) ? { categoryId: categoryBySlug.get(update.categorySlug)?.id } : {}) }; return this.prisma.channel.update({ where: { id: update.id }, data }); }));
    for (const part of chunks(variantUpdates, 1000)) await this.prisma.$transaction(part.map((update) => this.prisma.streamVariant.update({ where: { id: update.id }, data: { encryptedLocator: update.encryptedLocator, isActive: true } })));
    metrics.updated += updates.length + variantUpdates.length; metrics.processed = metrics.read; metrics.ignored = Math.max(0, metrics.read - metrics.created - metrics.updated - metrics.duplicates - metrics.errors); await this.prisma.importRun.update({ where: { id: importRunId }, data: { metrics: JSON.parse(JSON.stringify(metrics)) } }); return finalize ? this.finalizeIngest(source, importRunId, state) : metrics;
  }

  private async finalizeIngest(source: ImportSource, importRunId: string, state: ImportState): Promise<ImportMetrics> { await this.assertNotCanceled(importRunId); const active = await this.prisma.streamVariant.findMany({ where: { sourceId: source.id, isActive: true }, select: { id: true, channelId: true } }) as Array<{ id: string; channelId: string }>; const toPrune = active.filter((variant) => !state.seenChannelIds.has(variant.channelId)); for (const part of chunks(toPrune, 500)) { const result = await this.prisma.streamVariant.updateMany({ where: { id: { in: part.map((variant) => variant.id) } }, data: { isActive: false } }); state.metrics.pruned += result.count; } state.metrics.ignored = Math.max(0, state.metrics.read - state.metrics.created - state.metrics.updated - state.metrics.duplicates - state.metrics.errors); await this.prisma.importRun.update({ where: { id: importRunId }, data: { metrics: JSON.parse(JSON.stringify(state.metrics)) } }); return state.metrics; }
  private async storeChannelLogos(logoUrls: Map<string, string>, channels: Map<string, ExistingChannel>): Promise<number> { const unique = Array.from(new Set(logoUrls.values())).slice(0, this.logoMaxDownloads); const urlToKey = new Map<string, string>(); let cursor = 0; const worker = async (): Promise<void> => { for (;;) { const index = cursor++; if (index >= unique.length) return; try { const key = await this.storeOneLogo(unique[index]); if (key) urlToKey.set(unique[index], key); } catch { this.logger.warn('Logo ignoré pendant l’import'); } } }; await Promise.all(Array.from({ length: Math.min(LOGO_CONCURRENCY, Math.max(1, unique.length)) }, () => worker())); const updates: Array<{ id: string; logoKey: string }> = []; for (const [key, url] of logoUrls) { const channel = channels.get(key); const logoKey = urlToKey.get(url); if (channel && logoKey && channel.logoKey !== logoKey) updates.push({ id: channel.id, logoKey }); } for (const part of chunks(updates, 1000)) await this.prisma.$transaction(part.map((update) => this.prisma.channel.update({ where: { id: update.id }, data: { logoKey: update.logoKey } }))); return urlToKey.size; }
  private async storeOneLogo(url: string): Promise<string | null> { const result = await new SafeFetcher().fetchStream(url, { maxBytes: this.logoMaxBytes, streamTimeoutMs: this.logoTimeout, signal: undefined }); if (!result.ok || !result.stream) return null; const reader = result.stream.getReader(); const chunksOut: Uint8Array[] = []; let bytes = 0; for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > this.logoMaxBytes) { await reader.cancel(); return null; } chunksOut.push(next.value); } const buffer = Buffer.concat(chunksOut.map((part) => Buffer.from(part))); if (buffer.byteLength === 0) return null; const contentType = this.inferLogoContentType(result.contentType, url, buffer); if (!contentType) return null; const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' } as Record<string, string>)[contentType.split(';')[0]] ?? 'png'; const key = `logos/${createHash('sha256').update(url).digest('hex').slice(0, 16)}.${extension}`; if (!(await this.storage.get(key))) await this.storage.put(key, buffer, contentType); return key; }
  private inferLogoContentType(declared: string | undefined, url: string, buffer: Buffer): string | null {
    const extensionToType: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
    const declaredType = (declared ?? '').split(';')[0].trim().toLowerCase();
    if (declaredType.startsWith('image/')) return declaredType;
    const extensionMatch = url.match(/\.([a-z0-9]+)(?:[?#]|$)/i);
    if (extensionMatch) { const fromExt = extensionToType[extensionMatch[1].toLowerCase()]; if (fromExt) return fromExt; }
    if (buffer.length >= 12) {
      const head = buffer.subarray(0, 12);
      if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
      if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
      if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'image/gif';
      if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'image/webp';
      if (head[0] === 0x3c && head[1] === 0x73 && head[2] === 0x76 && head[3] === 0x67) return 'image/svg+xml';
    }
    return null;
  }
  private async assertNotCanceled(importRunId: string): Promise<void> { if (this.cancellation.signal(importRunId)?.aborted || await this.isCanceled(importRunId)) throw new ImportCanceled(); }
  private async isCanceled(importRunId: string): Promise<boolean> { const run = await this.prisma.importRun.findUnique({ where: { id: importRunId }, select: { state: true } }) as { state: string } | null; return run?.state === 'CANCELED'; }
  private async fail(sourceId: string, importRunId: string, code: string, error: unknown): Promise<void> { const message = messageOf(error).replace(/https?:\/\/[^\s]+/g, '[url masquée]').slice(0, 300); await this.prisma.importRun.update({ where: { id: importRunId }, data: { state: 'FAILED', errorCode: code, errorMessage: message, completedAt: new Date() } }); await this.prisma.source.update({ where: { id: sourceId }, data: { status: 'FAILED' } }); }
}

export type { SourceKind };
