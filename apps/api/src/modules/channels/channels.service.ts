import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Channel, ChannelListResponse, ChannelQuery, CountryOption, NowPlaying, PlayResponse, Programme } from '@mbolo/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.interface';
import { StreamingService } from '../streaming/streaming.service';

type ListedChannel = { id: string; name: string; canonicalName: string; country: string | null; categoryId: string | null; logoKey: string | null };
type CountryRow = { country: string | null; _count: { country: number } };
type ChannelProgramme = { id: string; channelId: string; startsAt: Date; endsAt: Date; title: string; description: string | null; imageUrl: string | null; metadata?: unknown | null };

function extractNowPlayingEnriched(metadata: unknown): Partial<NowPlaying> {
  if (!metadata || typeof metadata !== 'object') return {};
  const m = metadata as Record<string, unknown>;
  // Nouvelle clé `enriched` (TVmaze/Fanart.tv) ; `tmdb` en compat legacy.
  const src = ((m.enriched ?? m.tmdb) as Record<string, unknown> | null) ?? null;
  return {
    type: (m.type as NowPlaying['type']) ?? null,
    posterUrl: (src?.posterUrl as string | null) ?? null,
    backdropUrl: (src?.backdropUrl as string | null) ?? null,
  };
}

@Injectable()
export class ChannelsService {
  private readonly publicApiUrl: string; private readonly storageDriver: string; private readonly logoUrlTtlSeconds: number;
  constructor(private readonly prisma: PrismaService, private readonly streaming: StreamingService, private readonly storage: StorageService, config: ConfigService) { this.publicApiUrl = (config.get<string>('PUBLIC_API_URL') ?? config.get<string>('API_URL') ?? 'http://localhost:4000').replace(/\/+$/, ''); const configuredDriver = config.get<string>('STORAGE_DRIVER', 'local').trim().toLowerCase(); this.storageDriver = configuredDriver === 's3' || configuredDriver === 'cloudinary' || Boolean(config.get<string>('S3_ENDPOINT') && config.get<string>('S3_BUCKET')) ? 's3' : 'local'; this.logoUrlTtlSeconds = Math.min(Math.max(config.get<number>('S3_LOGO_URL_TTL_SECONDS', 300), 60), 3600); }
  async list(query: ChannelQuery): Promise<ChannelListResponse> {
    const hiddenIds = await this.hiddenCategoryIds();
    const categoryFilter = query.category
      ? { category: { slug: query.category, ...(hiddenIds.size ? { id: { notIn: [...hiddenIds] } } : {}) } }
      : hiddenIds.size ? { OR: [{ categoryId: null }, { categoryId: { notIn: [...hiddenIds] } }] } : {};
    const searchFilter = query.q ? { OR: [{ canonicalName: { contains: query.q, mode: 'insensitive' } }, { name: { contains: query.q, mode: 'insensitive' } }, { country: { contains: query.q, mode: 'insensitive' } }] } : {};
    const where: Record<string, unknown> = { isVisible: true, AND: [categoryFilter, searchFilter], ...(query.country ? { country: query.country } : {}), variants: { some: { isActive: true, OR: [{ healthStatus: null }, { healthStatus: 'OK' }] } } };
    const [channels, total] = await Promise.all([this.prisma.channel.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { canonicalName: 'asc' }], take: query.limit ?? 48, skip: query.offset ?? 0 }), this.prisma.channel.count({ where })]);
    const nowPlaying = await this.findNowPlaying(channels.map((channel: { id: string }) => channel.id)); const healthByChannel = await this.findHealthStatus(channels.map((channel: { id: string }) => channel.id)); const items = await Promise.all(channels.map((channel: ListedChannel) => this.serialize(channel, nowPlaying.get(channel.id) ?? null, healthByChannel.get(channel.id) ?? null)));
    return { items, total, hasMore: (query.offset ?? 0) + items.length < total };
  }
  async countries(): Promise<CountryOption[]> {
    const hiddenIds = await this.hiddenCategoryIds();
    const categoryClause = hiddenIds.size ? { OR: [{ categoryId: null }, { categoryId: { notIn: [...hiddenIds] } }] } : {};
    const rows = await this.prisma.channel.groupBy({ by: ['country'], where: { isVisible: true, ...categoryClause, country: { not: null }, variants: { some: { isActive: true, OR: [{ healthStatus: null }, { healthStatus: 'OK' }] } } }, _count: { country: true } });
    return rows.filter((row: CountryRow) => row.country !== null).map((row: CountryRow) => ({ slug: row.country as string, name: row.country as string, count: row._count.country })).sort((a: CountryOption, b: CountryOption) => b.count - a.count);
  }
  /** Chaînes précises par ids (favoris) : même sérialisation que list(), ordre à la charge de l'appelant. */
  async listByIds(ids: string[]): Promise<ChannelListResponse> {
    if (ids.length === 0) return { items: [], total: 0, hasMore: false };
    const hiddenIds = await this.hiddenCategoryIds();
    const categoryClause = hiddenIds.size ? { OR: [{ categoryId: null }, { categoryId: { notIn: [...hiddenIds] } }] } : {};
    const channels = await this.prisma.channel.findMany({ where: { id: { in: ids }, isVisible: true, ...categoryClause, variants: { some: { isActive: true, OR: [{ healthStatus: null }, { healthStatus: 'OK' }] } } } });
    const nowPlaying = await this.findNowPlaying(channels.map((channel: { id: string }) => channel.id));
    const healthByChannel = await this.findHealthStatus(channels.map((channel: { id: string }) => channel.id));
    const items = await Promise.all(channels.map((channel: ListedChannel) => this.serialize(channel, nowPlaying.get(channel.id) ?? null, healthByChannel.get(channel.id) ?? null)));
    return { items, total: items.length, hasMore: false };
  }
  async findOne(id: string): Promise<Channel> {
    const hiddenIds = await this.hiddenCategoryIds();
    const categoryClause = hiddenIds.size ? { OR: [{ categoryId: null }, { categoryId: { notIn: [...hiddenIds] } }] } : {};
    const channel = await this.prisma.channel.findFirst({ where: { id, isVisible: true, ...categoryClause, variants: { some: { isActive: true, OR: [{ healthStatus: null }, { healthStatus: 'OK' }] } } } });
    if (!channel) throw new NotFoundException('Channel not found');
    return this.serialize(channel, (await this.findNowPlaying([id])).get(id) ?? null, (await this.findHealthStatus([id])).get(id) ?? null);
  }
  async epg(id: string): Promise<Programme[]> {
    const hiddenIds = await this.hiddenCategoryIds();
    const categoryClause = hiddenIds.size ? { OR: [{ categoryId: null }, { categoryId: { notIn: [...hiddenIds] } }] } : {};
    const channel = await this.prisma.channel.findFirst({ where: { id, isVisible: true, ...categoryClause } });
    if (!channel) throw new NotFoundException('Channel not found');
    const from = new Date(Date.now() - 3 * 3_600_000);
    const to = new Date(Date.now() + 12 * 3_600_000);
    const programmes = await this.prisma.epgProgramme.findMany({ where: { channelId: id, startsAt: { lte: to }, endsAt: { gte: from } }, orderBy: { startsAt: 'asc' } });
    return programmes.map((programme: ChannelProgramme) => {
      const metadata = (programme as unknown as { metadata: Record<string, unknown> | null }).metadata ?? null;
      const enriched = extractNowPlayingEnriched(metadata);
      // Nouvelle clé `enriched` (TVmaze/Fanart.tv) ; `tmdb` en compat legacy.
      const src = ((metadata?.enriched ?? metadata?.tmdb) as Record<string, unknown> | null) ?? null;
      return {
        id: programme.id,
        channelId: programme.channelId,
        startsAt: programme.startsAt.toISOString(),
        endsAt: programme.endsAt.toISOString(),
        title: programme.title,
        description: programme.description,
        imageUrl: programme.imageUrl,
        type: enriched.type ?? null,
        posterUrl: enriched.posterUrl ?? null,
        backdropUrl: enriched.backdropUrl ?? null,
        trailerUrl: (src?.trailerUrl as string | null) ?? null,
        genres: (src?.genres as string[] | null) ?? null,
        year: (src?.year as number | null) ?? null,
      } as Programme;
    });
  }
  async play(id: string, deviceId: string | undefined, eco = false): Promise<PlayResponse> {
    const hiddenIds = await this.hiddenCategoryIds();
    const categoryClause = hiddenIds.size ? { OR: [{ categoryId: null }, { categoryId: { notIn: [...hiddenIds] } }] } : {};
    if (!(await this.prisma.channel.findFirst({ where: { id, isVisible: true, ...categoryClause } }))) throw new NotFoundException('Channel not found');
    return this.streaming.createPlay(id, deviceId, eco);
  }
  private async hiddenCategoryIds(): Promise<Set<string>> {
    const cats = await this.prisma.category.findMany({ select: { id: true, parentId: true, isVisible: true } });
    const byId = new Map(cats.map((category) => [category.id, category] as const));
    const effective = new Map<string, boolean>();
    const visiting = new Set<string>();
    const compute = (id: string): boolean => {
      const cached = effective.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) { effective.set(id, false); return false; }
      visiting.add(id);
      const node = byId.get(id);
      if (!node) { visiting.delete(id); return false; }
      const parentOk = node.parentId == null || !byId.has(node.parentId) ? true : compute(node.parentId);
      const result = node.isVisible && parentOk;
      visiting.delete(id);
      effective.set(id, result);
      return result;
    };
    cats.forEach((category) => compute(category.id));
    return new Set(cats.filter((category) => !effective.get(category.id)).map((category) => category.id));
  }
  private async findNowPlaying(channelIds: string[]): Promise<Map<string, NowPlaying>> {
    if (channelIds.length === 0) return new Map();
    const programmes = await this.prisma.epgProgramme.findMany({ where: { channelId: { in: channelIds }, startsAt: { lte: new Date() }, endsAt: { gt: new Date() } } });
    const map = new Map<string, NowPlaying>();
    for (const programme of programmes as unknown as Array<ChannelProgramme & { metadata?: unknown }>) {
      if (!map.has(programme.channelId)) {
        const enriched = extractNowPlayingEnriched((programme as unknown as { metadata: unknown }).metadata);
        map.set(programme.channelId, {
          startsAt: programme.startsAt.toISOString(),
          endsAt: programme.endsAt.toISOString(),
          title: programme.title,
          imageUrl: programme.imageUrl ?? null,
          type: enriched.type ?? null,
          posterUrl: enriched.posterUrl ?? null,
          backdropUrl: enriched.backdropUrl ?? null,
        });
      }
    }
    return map;
  }
  private async findHealthStatus(channelIds: string[]): Promise<Map<string, 'OK' | 'DOWN'>> { if (channelIds.length === 0) return new Map(); const variants = await this.prisma.streamVariant.findMany({ where: { channelId: { in: channelIds }, isActive: true }, select: { channelId: true, healthStatus: true } }); const map = new Map<string, 'OK' | 'DOWN'>(); for (const variant of variants) if (variant.healthStatus !== null && (map.get(variant.channelId) === undefined || variant.healthStatus === 'OK')) map.set(variant.channelId, variant.healthStatus as 'OK' | 'DOWN'); return map; }
  private async serialize(channel: ListedChannel, nowPlaying: NowPlaying | null, healthStatus: 'OK' | 'DOWN' | null): Promise<Channel> { return { id: channel.id, name: channel.name, canonicalName: channel.canonicalName, country: channel.country, categoryId: channel.categoryId, logoUrl: await this.resolveLogoUrl(channel.logoKey), healthStatus, nowPlaying }; }
  private async resolveLogoUrl(logoKey: string | null): Promise<string | null> { if (!logoKey) return null; if (/^https?:\/\//i.test(logoKey)) { try { const url = new URL(logoKey); if (url.protocol === 'http:') url.protocol = 'https:'; return url.toString(); } catch { return logoKey; } } try { return this.storageDriver === 'local' ? `${this.publicApiUrl}/uploads/${logoKey}` : await this.storage.signedUrl(logoKey, this.logoUrlTtlSeconds); } catch { return null; } }
}
