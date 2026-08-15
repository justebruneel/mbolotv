import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  Channel,
  ChannelListResponse,
  ChannelQuery,
  CountryOption,
  NowPlaying,
  PlayResponse,
  Programme,
} from '@mbolo/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StreamingService } from '../streaming/streaming.service';

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly streaming: StreamingService,
  ) {}

  async list(query: ChannelQuery): Promise<ChannelListResponse> {
    const where = {
      ...(query.category ? { category: { slug: query.category } } : {}),
      ...(query.country ? { country: query.country } : {}),
      ...(query.q ? { canonicalName: { contains: query.q } } : {}),
      // Seules les chaînes avec au moins une variante active sont lisibles.
      variants: { some: { isActive: true } },
    };

    const [channels, total] = await Promise.all([
      this.prisma.channel.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { canonicalName: 'asc' }],
        take: query.limit ?? 48,
        skip: query.offset ?? 0,
      }),
      this.prisma.channel.count({ where }),
    ]);

    const nowPlaying = await this.findNowPlaying(channels.map((channel) => channel.id));
    const healthByChannel = await this.findHealthStatus(channels.map((channel) => channel.id));
    const items = channels.map((channel) =>
      this.serialize(channel, nowPlaying.get(channel.id) ?? null, healthByChannel.get(channel.id) ?? null),
    );

    return {
      items,
      total,
      hasMore: (query.offset ?? 0) + items.length < total,
    };
  }

  async countries(): Promise<CountryOption[]> {
    const rows = await this.prisma.channel.groupBy({
      by: ['country'],
      where: { country: { not: null }, variants: { some: { isActive: true } } },
      _count: { country: true },
    });
    return rows
      .filter((row) => row.country !== null)
      .map((row) => ({
        slug: row.country as string,
        name: row.country as string,
        count: row._count.country,
      }))
      .sort((a, b) => b.count - a.count);
  }

  async findOne(id: string): Promise<Channel> {
    const channel = await this.prisma.channel.findFirst({
      where: { id, variants: { some: { isActive: true } } },
    });
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
    const programmes = await this.prisma.epgProgramme.findMany({
      where: { channelId: id, startsAt: { lte: to }, endsAt: { gte: from } },
      orderBy: { startsAt: 'asc' },
    });

    return programmes.map((programme) => ({
      id: programme.id,
      channelId: programme.channelId,
      startsAt: programme.startsAt.toISOString(),
      endsAt: programme.endsAt.toISOString(),
      title: programme.title,
      description: programme.description,
    }));
  }

  async play(id: string): Promise<PlayResponse> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw new NotFoundException('Channel not found');
    return this.streaming.createPlay(id);
  }

  private async findNowPlaying(channelIds: string[]): Promise<Map<string, NowPlaying>> {
    if (channelIds.length === 0) return new Map();
    const now = new Date();
    const programmes = await this.prisma.epgProgramme.findMany({
      where: { channelId: { in: channelIds }, startsAt: { lte: now }, endsAt: { gt: now } },
    });
    const map = new Map<string, NowPlaying>();
    for (const programme of programmes) {
      if (!map.has(programme.channelId)) {
        map.set(programme.channelId, {
          startsAt: programme.startsAt.toISOString(),
          endsAt: programme.endsAt.toISOString(),
          title: programme.title,
        });
      }
    }
    return map;
  }

  private async findHealthStatus(channelIds: string[]): Promise<Map<string, 'OK' | 'DOWN'>> {
    if (channelIds.length === 0) return new Map();
    const variants = await this.prisma.streamVariant.findMany({
      where: { channelId: { in: channelIds }, isActive: true },
      select: { channelId: true, healthStatus: true },
    });
    const map = new Map<string, 'OK' | 'DOWN'>();
    for (const variant of variants) {
      if (variant.healthStatus === null) continue;
      const current = map.get(variant.channelId);
      if (current === undefined) {
        map.set(variant.channelId, variant.healthStatus as 'OK' | 'DOWN');
      } else if (variant.healthStatus === 'OK') {
        map.set(variant.channelId, 'OK');
      }
    }
    return map;
  }

  private serialize(
    channel: { id: string; name: string; canonicalName: string; country: string | null; categoryId: string | null; logoKey: string | null },
    nowPlaying: NowPlaying | null,
    healthStatus: 'OK' | 'DOWN' | null,
  ): Channel {
    return {
      id: channel.id,
      name: channel.name,
      canonicalName: channel.canonicalName,
      country: channel.country,
      categoryId: channel.categoryId,
      logoUrl: channel.logoKey,
      healthStatus,
      nowPlaying,
    };
  }
}
