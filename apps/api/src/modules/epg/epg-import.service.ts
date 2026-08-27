import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { SafeFetcher } from '../sources/safe-fetcher';
import { parseXmltvStream, type XmltvProgramme } from './xmltv.parser';
import { EpgOrchestrator } from './epg-orchestrator.service';

export interface EpgImportResult { sources: number; channels: number; programmes: number; stored: number; durationMs: number; }
type EpgSource = { id: string; name: string; kind: string; status: string; priority: number; connectionEncrypted: Uint8Array; epgUrl?: string | null };
type EpgRow = { channelId: string; startsAt: Date; endsAt: Date; title: string; description?: string | null; imageUrl?: string | null; metadata?: Record<string, unknown> };
type _EpgCreateResult = { count: number };
type BufferedProgramme = { xmltvChannelId: string; startsAt: Date; endsAt: Date; title: string; description?: string | null; imageUrl?: string | null; categories: string[] };

function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

@Injectable()
export class EpgImportService {
  private readonly logger = new Logger(EpgImportService.name);
  private fullRunInProgress = false;
  private readonly runningSources = new Set<string>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    @Optional() private readonly orchestrator?: EpgOrchestrator,
  ) {}
  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async run(): Promise<EpgImportResult> {
    const startedAt = Date.now();
    if (this.fullRunInProgress || this.runningSources.size > 0) return { sources: 0, channels: 0, programmes: 0, stored: 0, durationMs: Date.now() - startedAt };
    this.fullRunInProgress = true;
    try {
      const sources = await this.prisma.source.findMany({ where: { status: { not: 'DISABLED' }, OR: [{ kind: 'XTREAM' }, { epgUrl: { not: null } }] }, orderBy: [{ priority: 'asc' }] }) as EpgSource[];
      const tvgMap = await this.buildTvgMap();
      const nameMap = await this.buildNameMap();
      if (tvgMap.size === 0) return { sources: 0, channels: 0, programmes: 0, stored: 0, durationMs: Date.now() - startedAt };
      const channelIds = [...tvgMap.values()];
      for (let i = 0; i < channelIds.length; i += 10_000) await this.prisma.epgProgramme.deleteMany({ where: { channelId: { in: channelIds.slice(i, i + 10_000) } } });
      const fetcher = new SafeFetcher(); const maxBytes = Number(this.config.get('EPG_MAX_BYTES') ?? 512 * 1024 * 1024); let channels = 0; let programmes = 0; let stored = 0; let sourcesDone = 0;
      for (const source of sources) {
        try {
          const connection = JSON.parse(this.crypto.decrypt(source.connectionEncrypted)) as Record<string, string>; const url = source.epgUrl || this.buildXmltvUrl(connection); if (!url) continue;
          const result = await fetcher.fetchStream(url, { maxBytes, streamTimeoutMs: 15 * 60_000, userAgent: 'MboloTV/0.1 (EPG import)' }); if (!result.ok || !result.stream) { this.logger.warn(`EPG indisponible pour ${source.name}: ${result.error}`); continue; }
          const collected = await this.collectXmltv(result.stream);
          const { rows, matched } = this.resolveProgrammes(collected.programmes, collected.channelNames, tvgMap, nameMap);
          if (rows.length > 0) await this.prisma.epgProgramme.createMany({ data: rows as never });
          channels += matched.size; programmes += collected.count; stored += rows.length; sourcesDone += 1; await this.prisma.source.update({ where: { id: source.id }, data: { lastSyncedAt: new Date() } }); this.logger.log(`EPG ${source.name}: ${matched.size} chaînes, ${rows.length} programmes sur ${collected.count}`);
        } catch (error) { this.logger.error(`Échec EPG ${source.name}: ${String(error)}`); }
      }
      // Providers gratuits complémentaires (Afrique + Europe) — n'écrase pas les programmes Xtream déjà présents, remplit les trous
      if (this.orchestrator) {
        try {
          const mapping = await this.buildChannelEpgMapping();
          const extra = await this.orchestrator.importExtraEpg(tvgMap, nameMap, mapping);
          if (extra.stored > 0) {
            this.logger.log(`EPG extra: ${extra.providers.join(',')} → ${extra.stored} programmes (${extra.totalPrograms} dédupliqués)`);
            stored += extra.stored;
            channels += extra.providers.length;
          }
          if (extra.unmatchedSample.length > 0) this.logger.warn(`EPG extra non mappés: ${extra.unmatchedSample.join(' | ')}`);
        } catch (error) {
          this.logger.warn(`EPG extra échoué: ${String((error as Error).message ?? error)}`);
        }
      }
      return { sources: sourcesDone, channels, programmes, stored, durationMs: Date.now() - startedAt };
    } finally {
      this.fullRunInProgress = false;
    }
  }
  async runForSource(sourceId: string): Promise<EpgImportResult> {
    const startedAt = Date.now();
    if (this.fullRunInProgress || this.runningSources.has(sourceId)) return { sources: 0, channels: 0, programmes: 0, stored: 0, durationMs: Date.now() - startedAt };
    this.runningSources.add(sourceId);
    try {
      const source = await this.prisma.source.findUnique({ where: { id: sourceId } }) as EpgSource | null;
      if (!source || source.status === 'DISABLED') return { sources: 0, channels: 0, programmes: 0, stored: 0, durationMs: Date.now() - startedAt };
      const connection = JSON.parse(this.crypto.decrypt(source.connectionEncrypted)) as Record<string, string>;
      const url = source.epgUrl || this.buildXmltvUrl(connection);
      if (!url) return { sources: 0, channels: 0, programmes: 0, stored: 0, durationMs: Date.now() - startedAt };
      const tvgMap = await this.buildTvgMap();
      const nameMap = await this.buildNameMap();
      if (tvgMap.size === 0) return { sources: 0, channels: 0, programmes: 0, stored: 0, durationMs: Date.now() - startedAt };
      const fetcher = new SafeFetcher();
      const maxBytes = Number(this.config.get('EPG_MAX_BYTES') ?? 512 * 1024 * 1024);
      const result = await fetcher.fetchStream(url, { maxBytes, streamTimeoutMs: 15 * 60_000, userAgent: 'MboloTV/0.1 (EPG import)' });
      if (!result.ok || !result.stream) { this.logger.warn(`EPG indisponible pour ${source.name}: ${result.error}`); return { sources: 0, channels: 0, programmes: 0, stored: 0, durationMs: Date.now() - startedAt }; }
      const collected = await this.collectXmltv(result.stream);
      const { rows, matched } = this.resolveProgrammes(collected.programmes, collected.channelNames, tvgMap, nameMap);
      if (matched.size > 0) {
        const matchedIds = [...matched];
        for (let i = 0; i < matchedIds.length; i += 10_000) await this.prisma.epgProgramme.deleteMany({ where: { channelId: { in: matchedIds.slice(i, i + 10_000) } } });
        for (let i = 0; i < rows.length; i += 5000) {
          const slice = rows.slice(i, i + 5000);
          await this.prisma.epgProgramme.createMany({ data: slice as never });
        }
      }
      await this.prisma.source.update({ where: { id: source.id }, data: { lastSyncedAt: new Date() } });
      this.logger.log(`EPG ${source.name}: ${matched.size} chaînes, ${rows.length} programmes sur ${collected.count}`);
      return { sources: 1, channels: matched.size, programmes: collected.count, stored: rows.length, durationMs: Date.now() - startedAt };
    } catch (error) {
      this.logger.error(`Échec EPG source ${sourceId}: ${String(error)}`);
      return { sources: 0, channels: 0, programmes: 0, stored: 0, durationMs: Date.now() - startedAt };
    } finally {
      this.runningSources.delete(sourceId);
    }
  }
  private async buildTvgMap(): Promise<Map<string, string>> { const channels = await this.prisma.channel.findMany({ where: { tvgId: { not: null } }, select: { id: true, tvgId: true } }) as Array<{ id: string; tvgId: string | null }>; const map = new Map<string, string>(); for (const channel of channels) if (channel.tvgId) map.set(channel.tvgId.toLowerCase(), channel.id); return map; }
  private async buildNameMap(): Promise<Map<string, string>> { const channels = await this.prisma.channel.findMany({ select: { id: true, name: true } }) as Array<{ id: string; name: string }>; const map = new Map<string, string>(); for (const channel of channels) map.set(normalizeName(channel.name), channel.id); return map; }
  private async collectXmltv(stream: ReadableStream<Uint8Array>): Promise<{ programmes: BufferedProgramme[]; channelNames: Record<string, string>; count: number }> {
    const programmes: BufferedProgramme[] = [];
    let count = 0;
    const parseResult = await parseXmltvStream(stream, async (batch: XmltvProgramme[]) => {
      for (const programme of batch) {
        count += 1;
        programmes.push({ xmltvChannelId: programme.channelId, startsAt: programme.startsAt, endsAt: programme.endsAt, title: programme.title, description: programme.description, imageUrl: programme.imageUrl, categories: programme.categories });
      }
      return 0;
    });
    return { programmes, channelNames: parseResult.channelNames, count };
  }
  private resolveProgrammes(programmes: BufferedProgramme[], channelNames: Record<string, string>, tvgMap: Map<string, string>, nameMap: Map<string, string>): { rows: EpgRow[]; matched: Set<string> } {
    const rows: EpgRow[] = [];
    const matched = new Set<string>();
    for (const programme of programmes) {
      let channelId = tvgMap.get(programme.xmltvChannelId.toLowerCase());
      if (!channelId) {
        const displayName = channelNames[programme.xmltvChannelId];
        if (displayName) channelId = nameMap.get(normalizeName(displayName));
      }
      if (!channelId) continue;
      matched.add(channelId);
      rows.push({ channelId, startsAt: programme.startsAt, endsAt: programme.endsAt, title: programme.title, description: programme.description, imageUrl: programme.imageUrl, metadata: programme.categories.length > 0 ? { categories: programme.categories } : undefined });
    }
    return { rows, matched };
  }
  private buildXmltvUrl(connection: Record<string, string>): string | null { const host = connection['host'] ?? connection['url']; const username = connection['username']; const password = connection['password']; if (!host || !username || !password) return null; const base = host.replace(/\/+$/, ''); return `${base}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`; }
  private async buildChannelEpgMapping(): Promise<Map<string, string>> {
    try {
      const rows = await (this.prisma as unknown as { channelEpgMapping: { findMany: () => Promise<Array<{ channelId: string; provider: string; externalId: string }>> } }).channelEpgMapping.findMany();
      const map = new Map<string, string>();
      for (const r of rows) map.set(`${r.externalId}::${r.provider}`, r.channelId);
      return map;
    } catch {
      return new Map();
    }
  }
}
