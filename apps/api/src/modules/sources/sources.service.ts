import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ConnectTestResponse,
  ImportRun,
  ImportRunListResponse,
  SourceCreateInput,
  SourceDetail,
  SourceResponse,
  SourceUpdateInput,
} from '@mbolo/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JobQueue } from '../../common/queue/queue.interface';
import { StorageService } from '../../common/storage/storage.interface';
import { SafeFetcher } from './safe-fetcher';

const ACTIVE_IMPORT_STATES = ['QUEUED', 'FETCHING', 'PARSING', 'NORMALIZING'];
const UPLOAD_MAX_BYTES = 512 * 1024 * 1024;

@Injectable()
export class SourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly queue: JobQueue,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  async list(ownerId: string): Promise<SourceResponse[]> {
    const sources = await this.prisma.source.findMany({
      where: { ownerId },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
    return sources.map((source) => this.serialize(source, null));
  }

  async detail(ownerId: string, id: string): Promise<SourceDetail> {
    const source = await this.findOwned(ownerId, id);
    const variantsCount = await this.prisma.streamVariant.count({ where: { sourceId: id } });
    let connectionMasked: Record<string, string> = {};
    try {
      const connection = JSON.parse(this.crypto.decrypt(source.connectionEncrypted)) as Record<string, string>;
      connectionMasked = Object.fromEntries(Object.entries(connection).map(([key, value]) => [key, this.maskValue(value)]));
    } catch {
      connectionMasked = { error: 'Impossible de déchiffrer la connexion' };
    }
    return this.serialize(source, null, { connectionMasked, variantsCount }) as SourceDetail;
  }

  async create(ownerId: string, input: SourceCreateInput): Promise<SourceResponse> {
    const encrypted = this.crypto.encrypt(JSON.stringify(input.connection));
    const source = await this.prisma.source.create({
      data: { ownerId, name: input.name, kind: input.kind, connectionEncrypted: encrypted, status: 'PENDING' },
    });
    await this.audit.log(ownerId, 'source.create', 'source', source.id, { kind: input.kind, name: input.name });
    if (input.kind === 'M3U' && (input.connection['url'] || input.connection['playlistUrl'])) {
      await this.startImport(ownerId, source.id, { silentAudit: true });
    }
    return this.serialize(source, null);
  }

  async update(ownerId: string, id: string, input: SourceUpdateInput): Promise<SourceResponse> {
    await this.findOwned(ownerId, id);
    const updated = await this.prisma.source.update({
      where: { id },
      data: { name: input.name, priority: input.priority, status: input.status },
    });
    await this.audit.log(ownerId, 'source.update', 'source', id, { changes: input });
    return this.serialize(updated, null);
  }

  async remove(ownerId: string, id: string): Promise<void> {
    const source = await this.findOwned(ownerId, id);
    await this.prisma.source.delete({ where: { id } });
    const orphans = await this.prisma.channel.findMany({ where: { variants: { none: {} } }, select: { id: true } });
    let removed = 0;
    for (let i = 0; i < orphans.length; i += 10_000) {
      const chunk = orphans.slice(i, i + 10_000);
      const result = await this.prisma.channel.deleteMany({ where: { id: { in: chunk.map((channel) => channel.id) } } });
      removed += result.count;
    }
    await this.audit.log(ownerId, 'source.delete', 'source', id, { name: source.name, orphanChannelsRemoved: removed });
  }

  async test(ownerId: string, id: string): Promise<ConnectTestResponse> {
    const source = await this.findOwned(ownerId, id);
    const connection = JSON.parse(this.crypto.decrypt(source.connectionEncrypted)) as Record<string, string>;
    const probe = this.buildProbe(source.kind, connection);
    await this.audit.log(ownerId, 'source.test', 'source', id);
    if (source.kind === 'M3U' && connection['filePath']) {
      const root = resolve(this.config.get<string>('STORAGE_LOCAL_DIR', './uploads'));
      const absolute = resolve(root, connection['filePath']);
      try {
        const info = await stat(absolute);
        return { ok: info.isFile(), latencyMs: null, error: info.isFile() ? null : 'Fichier local introuvable' };
      } catch {
        return { ok: false, latencyMs: null, error: 'Fichier local introuvable' };
      }
    }
    if (!probe) return { ok: false, latencyMs: null, error: 'Connexion incomplète : paramètres manquants' };
    const result = await new SafeFetcher().fetch(probe);
    return { ok: result.ok, latencyMs: result.latencyMs, error: result.error ?? null };
  }

  async importNow(ownerId: string, id: string): Promise<ImportRun> {
    return this.startImport(ownerId, id);
  }

  async replacePlaylist(ownerId: string, id: string, body: Buffer): Promise<SourceResponse> {
    const source = await this.findOwned(ownerId, id);
    if (source.kind !== 'M3U') throw new BadRequestException('Le téléversement de playlist ne concerne que les sources M3U');
    if (this.config.get<string>('STORAGE_DRIVER', 'local') !== 'local') throw new BadRequestException('Le téléversement nécessite STORAGE_DRIVER=local');
    if (!body || body.byteLength === 0) throw new BadRequestException('Fichier vide');
    if (body.byteLength > UPLOAD_MAX_BYTES) throw new PayloadTooLargeException(`Fichier trop volumineux (max ${UPLOAD_MAX_BYTES / (1024 * 1024)} Mo)`);
    const head = body.subarray(0, Math.min(body.byteLength, 512)).toString('utf8').trimStart();
    if (!head.startsWith('#EXTM3U')) throw new BadRequestException('Le fichier ne ressemble pas à une playlist M3U (en-tête #EXTM3U manquant)');

    const key = `playlists/${source.id}.m3u`;
    await this.storage.put(key, body, 'application/x-mpegurl');
    const updated = await this.prisma.source.update({
      where: { id },
      data: { connectionEncrypted: this.crypto.encrypt(JSON.stringify({ filePath: key })), status: 'PENDING' },
    });
    await this.audit.log(ownerId, 'source.upload_playlist', 'source', id, { bytes: body.byteLength });
    await this.startImport(ownerId, id);
    return this.serialize(updated, null);
  }

  async listImports(ownerId: string): Promise<ImportRunListResponse> {
    const runs = await this.prisma.importRun.findMany({
      where: { source: { ownerId } },
      include: { source: true },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
    return { items: runs.map((run) => this.serializeRun(run)), total: runs.length };
  }

  async importDetail(ownerId: string, id: string): Promise<ImportRun> {
    const run = await this.prisma.importRun.findFirst({
      where: { id, source: { ownerId } },
      include: { source: true },
    });
    if (!run) throw new NotFoundException('Import introuvable');
    return this.serializeRun(run);
  }

  private async startImport(ownerId: string, sourceId: string, options?: { silentAudit?: boolean }): Promise<ImportRun> {
    const source = await this.prisma.source.findUnique({ where: { id: sourceId } });
    if (!source) throw new NotFoundException('Source introuvable');
    if (source.status === 'DISABLED') throw new ConflictException('Source désactivée : réactivez-la avant d’importer');
    const activeRun = await this.prisma.importRun.findFirst({ where: { sourceId, state: { in: ACTIVE_IMPORT_STATES } } });
    if (activeRun) throw new ConflictException('Un import est déjà en cours pour cette source');
    const run = await this.prisma.importRun.create({ data: { sourceId, state: 'QUEUED', startedAt: new Date() } });
    await this.queue.enqueue('source.import', { sourceId, importRunId: run.id });
    if (!options?.silentAudit) await this.audit.log(ownerId, 'source.import_request', 'source', sourceId, { importRunId: run.id });
    return this.serializeRun({ ...run, source });
  }

  private buildProbe(kind: string, connection: Record<string, string>): string | null {
    if (kind === 'M3U') return connection['url'] ?? connection['playlistUrl'] ?? null;
    if (kind === 'XTREAM') {
      const host = connection['host'] ?? connection['url'];
      const username = connection['username'];
      const password = connection['password'];
      if (!host || !username || !password) return null;
      return `${host.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    }
    if (kind === 'MAC_PORTAL') {
      const portal = connection['portal'] ?? connection['url'];
      return portal ? `${portal.replace(/\/+$/, '')}/portal.php` : null;
    }
    return null;
  }

  private maskValue(value: string): string {
    if (!value) return '••••';
    const visible = value.replace(/^https?:\/\//, '').slice(0, 4);
    return value.length <= 8 ? '••••' : `${visible}…`;
  }

  private async findOwned(ownerId: string, id: string) {
    const source = await this.prisma.source.findFirst({ where: { id, ownerId } });
    if (!source) throw new NotFoundException('Source introuvable');
    return source;
  }

  private serialize(source: { id: string; name: string; kind: string; status: string; priority: number; lastSyncedAt: Date | null; createdAt: Date }, _unused?: null, extra?: Partial<SourceDetail>): SourceResponse & Partial<SourceDetail> {
    return {
      id: source.id,
      name: source.name,
      kind: source.kind as SourceResponse['kind'],
      status: source.status as SourceResponse['status'],
      priority: source.priority,
      lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
      createdAt: source.createdAt.toISOString(),
      ...extra,
    };
  }

  private serializeRun(run: { id: string; sourceId: string; state: string; metrics: unknown; errorCode: string | null; errorMessage: string | null; startedAt: Date; completedAt: Date | null; source?: { name: string } }): ImportRun {
    return {
      id: run.id,
      sourceId: run.sourceId,
      sourceName: run.source?.name ?? 'source supprimée',
      state: run.state as ImportRun['state'],
      metrics: run.metrics as ImportRun['metrics'],
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    };
  }
}
