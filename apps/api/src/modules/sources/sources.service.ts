import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
import { SafeFetcher } from './safe-fetcher';

const ACTIVE_IMPORT_STATES = ['QUEUED', 'FETCHING', 'PARSING', 'NORMALIZING'];

@Injectable()
export class SourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly queue: JobQueue,
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
      const connection = JSON.parse(
        this.crypto.decrypt(source.connectionEncrypted),
      ) as Record<string, string>;
      connectionMasked = Object.fromEntries(
        Object.entries(connection).map(([key, value]) => [key, this.maskValue(value)]),
      );
    } catch {
      connectionMasked = { error: 'Impossible de déchiffrer la connexion' };
    }
    return this.serialize(source, null, { connectionMasked, variantsCount }) as SourceDetail;
  }

  async create(ownerId: string, input: SourceCreateInput): Promise<SourceResponse> {
    const encrypted = this.crypto.encrypt(JSON.stringify(input.connection));
    const source = await this.prisma.source.create({
      data: {
        ownerId,
        name: input.name,
        kind: input.kind,
        connectionEncrypted: encrypted,
        status: 'PENDING',
      },
    });
    await this.audit.log(ownerId, 'source.create', 'source', source.id, {
      kind: input.kind,
      name: input.name,
    });

    if (input.kind === 'M3U') {
      await this.startImport(ownerId, source.id, { silentAudit: true });
    }
    return this.serialize(source, null);
  }

  async update(ownerId: string, id: string, input: SourceUpdateInput): Promise<SourceResponse> {
    await this.findOwned(ownerId, id);
    const updated = await this.prisma.source.update({
      where: { id },
      data: {
        name: input.name,
        priority: input.priority,
        status: input.status,
      },
    });
    await this.audit.log(ownerId, 'source.update', 'source', id, { changes: input });
    return this.serialize(updated, null);
  }

  async remove(ownerId: string, id: string): Promise<void> {
    const source = await this.findOwned(ownerId, id);
    await this.prisma.source.delete({ where: { id } });
    // Les chaînes qui ne dépendent que de cette source deviennent orphelines
    // (plus aucune variante) : on les supprime pour ne pas les afficher.
    const orphans = await this.prisma.channel.findMany({
      where: { variants: { none: {} } },
      select: { id: true },
    });
    if (orphans.length > 0) {
      await this.prisma.channel.deleteMany({
        where: { id: { in: orphans.map((channel) => channel.id) } },
      });
    }
    await this.audit.log(ownerId, 'source.delete', 'source', id, {
      name: source.name,
      orphanChannelsRemoved: orphans.length,
    });
  }

  async test(ownerId: string, id: string): Promise<ConnectTestResponse> {
    const source = await this.findOwned(ownerId, id);
    const connection = JSON.parse(
      this.crypto.decrypt(source.connectionEncrypted),
    ) as Record<string, string>;

    const probe = this.buildProbe(source.kind, connection);
    await this.audit.log(ownerId, 'source.test', 'source', id);

    if (!probe) {
      return { ok: false, latencyMs: null, error: 'Connexion incomplète : paramètres manquants' };
    }

    const fetcher = new SafeFetcher();
    const result = await fetcher.fetch(probe);
    return {
      ok: result.ok,
      latencyMs: result.latencyMs,
      error: result.error ?? null,
    };
  }

  async importNow(ownerId: string, id: string): Promise<ImportRun> {
    return this.startImport(ownerId, id);
  }

  async listImports(): Promise<ImportRunListResponse> {
    const runs = await this.prisma.importRun.findMany({
      include: { source: true },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
    return {
      items: runs.map((run) => this.serializeRun(run)),
      total: runs.length,
    };
  }

  async importDetail(id: string): Promise<ImportRun> {
    const run = await this.prisma.importRun.findUnique({
      where: { id },
      include: { source: true },
    });
    if (!run) throw new NotFoundException('Import introuvable');
    return this.serializeRun(run);
  }

  private async startImport(ownerId: string, sourceId: string, options?: { silentAudit?: boolean }): Promise<ImportRun> {
    const source = await this.prisma.source.findUnique({ where: { id: sourceId } });
    if (!source) throw new NotFoundException('Source introuvable');
    if (source.status === 'DISABLED') {
      throw new ConflictException('Source désactivée : réactivez-la avant d’importer');
    }

    const activeRun = await this.prisma.importRun.findFirst({
      where: { sourceId, state: { in: ACTIVE_IMPORT_STATES } },
    });
    if (activeRun) {
      throw new ConflictException('Un import est déjà en cours pour cette source');
    }

    const run = await this.prisma.importRun.create({
      data: { sourceId, state: 'QUEUED', startedAt: new Date() },
    });
    await this.queue.enqueue('source.import', { sourceId, importRunId: run.id });
    if (!options?.silentAudit) {
      await this.audit.log(ownerId, 'source.import_request', 'source', sourceId, { importRunId: run.id });
    }
    return this.serializeRun({ ...run, source });
  }

  private buildProbe(kind: string, connection: Record<string, string>): string | null {
    if (kind === 'M3U') return connection['url'] ?? connection['playlistUrl'] ?? null;
    if (kind === 'XTREAM') {
      const host = connection['host'] ?? connection['url'];
      const username = connection['username'];
      const password = connection['password'];
      if (!host || !username || !password) return null;
      const base = host.replace(/\/+$/, '');
      return `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
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

  private serialize(
    source: {
      id: string;
      name: string;
      kind: string;
      status: string;
      priority: number;
      lastSyncedAt: Date | null;
      createdAt: Date;
    },
    _unused?: null,
    extra?: Partial<SourceDetail>,
  ): SourceResponse & Partial<SourceDetail> {
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

  private serializeRun(run: {
    id: string;
    sourceId: string;
    state: string;
    metrics: unknown;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: Date;
    completedAt: Date | null;
    source?: { name: string };
  }): ImportRun {
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