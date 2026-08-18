import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Channel, ChannelListResponse, ChannelQuery, CountryOption, NowPlaying, PlayResponse, Programme } from '@mbolo/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.interface';
import { StreamingService } from '../streaming/streaming.service';

@Injectable()
export class ChannelsService {
  private readonly publicApiUrl: string;
  private readonly storageDriver: string;
  private readonly logoUrlTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly streaming: StreamingService,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.publicApiUrl = (config.get<string>('PUBLIC_API_URL') ?? config.get<string>('API_URL') ?? 'http://localhost:4000').replace(/\/+$/, '');
    this.storageDriver = config.get<string>('STORAGE_DRIVER', 'local');
    this.logoUrlTtlSeconds = config.get<number>('S3_LOGO_URL_TTL_SECONDS', 300);
  }

  async list(query: ChannelQuery): Promise<ChannelListResponse> {
    const where = {
      ...(query.category ? { category: { slug: query.category } } : {}),
      ...(query.country ? { country: query.country } : {}),
      ...(query.q ? { canonicalName: { contains: query.q } } : {}),
      variants: { some: { isActive: true, OR: [{ healthStatus: null }, { healthStatus: 'OK' }] } },
    };
    const [channels, total] = await Promise.all([
      this.prisma.channel.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { canonicalName: 'asc' }], take: query.limit ?? 48, skip: query.offset ?? 0 }),
      this.prisma.channel.count({ where }),
    ]);
    const nowPlaying = await this.findNowPlaying(channels.map((channel) => channel.id));
    const healthByChannel = await this.findHealthStatus(channels.map((channel) => channel.id));
    const items = await Promise.all(channels.map((channel) => this.serialize(channel, nowPlaying.get(channel.id) ?? null, healthByChannel.get(channel.id) ?? null)));
    return { items, total, hasMore: (query.offset ?? 0) + items.length < total };
  }

  async countries(): Promise<CountryOption[]> {
    const rows = await this.prisma.channel.groupBy({ by: ['country'], where: { country: { not: null }, variants: { some: { isActive: true, OR: [{ healthStatus: null }, { healthStatus: 'OK' }] } } }, _count: { country: true } });
    return rows.filter((row) => row.country !== null).map((row) => ({ slug: row.country as string, name: row.country as string, count: row._count.country })).sort((a, b) => b.count - a.count);
  }

  async findOne(id: string): Promise<Channel> {
    const channel = await this.prisma.channel.findFirst({ where: { id, variants: { some: { isActive: true, OR: [{ healthStatus: null }, { healthStatus: 'OK' }] } } } });
    if (!channel) throw new NotFoundException('Channel not found');
    const nowPlaying = (await this.findNowPlaying([id])).get(id) ?? null;
    const healthStatus = (await this.findHealthStatus([id])).get(id) ?? null;
    return this.serialize(channel, nowPlaying, healthStatus);
  }

  async epg(id: string): Promise<Programme[]> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw new NotFoundException('Channel not found');
    const from = new Date(Date.now() - 3 * 3_600_000);
    const to = new Date(Date.now() + 12 * 3_600_000);
    const programmes = await this.prisma.epgProgramme.findMany({ where: { channelId: id, startsAt: { lte: to }, endsAt: { gte: from } }, orderBy: { startsAt: 'asc' } });
    return programmes.map((programme) => ({ id: programme.id, channelId: programme.channelId, startsAt: programme.startsAt.toISOString(), endsAt: programme.endsAt.toISOString(), title: programme.title, description: programme.description }));
  }

  async play(id: string): Promise<PlayResponse> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw new NotFoundException('Channel not found');
    return this.streaming.createPlay(id);
  }

  private async findNowPlaying(channelIds: string[]): Promise<Map<string, NowPlaying>> {
    if (channelIds.length === 0) return new Map();
    const now = new Date();
    const programmes = await this.prisma.epgProgramme.findMany({ where: { channelId: { in: channelIds }, startsAt: { lte: now }, endsAt: { gt: now } } });
    const map = new Map<string, NowPlaying>();
    for (const programme of programmes) if (!map.has(programme.channelId)) map.set(programme.channelId, { startsAt: programme.startsAt.toISOString(), endsAt: programme.endsAt.toISOString(), title: programme.title });
    return map;
  }

  private async findHealthStatus(channelIds: string[]): Promise<Map<string, 'OK' | 'DOWN'>> {
    if (channelIds.length === 0) return new Map();
    const variants = await this.prisma.streamVariant.findMany({ where: { channelId: { in: channelIds }, isActive: true }, select: { channelId: true, healthStatus: true } });
    const map = new Map<string, 'OK' | 'DOWN'>();
    for (const variant of variants) {
      if (variant.healthStatus === null) continue;
      const current = map.get(variant.channelId);
      if (current === undefined || variant.healthStatus === 'OK') map.set(variant.channelId, variant.healthStatus as 'OK' | 'DOWN');
    }
    return map;
  }

  private async serialize(channel: { id: string; name: string; canonicalName: string; country: string | null; categoryId: string | null; logoKey: string | null }, nowPlaying: NowPlaying | null, healthStatus: 'OK' | 'DOWN' | null): Promise<Channel> {
    return { id: channel.id, name: channel.name, canonicalName: channel.canonicalName, country: channel.country, categoryId: channel.categoryId, logoUrl: await this.resolveLogoUrl(channel.logoKey), healthStatus, nowPlaying };
  }

  private async resolveLogoUrl(logoKey: string | null): Promise<string | null> {
    if (!logoKey || /^https?:\/\//i.test(logoKey)) return null;
    if (this.storageDriver === 's3') {
      try { return await this.storage.signedUrl(logoKey, this.logoUrlTtlSeconds); } catch { return null; }
    }
    return `${this.publicApiUrl}/uploads/${logoKey}`;
  }
}
