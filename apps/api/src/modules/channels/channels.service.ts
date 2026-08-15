import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  Channel,
  ChannelListResponse,
  ChannelQuery,
  NowPlaying,
  PlayResponse,
  Programme,
} from '@mbolo/contracts';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async list(query: ChannelQuery): Promise<ChannelListResponse> {
    const where = {
      ...(query.category ? { category: { slug: query.category } } : {}),
      ...(query.q ? { canonicalName: { contains: query.q } } : {}),
    };

    const [channels, total] = await Promise.all([
      this.prisma.channel.findMany({
        where,
        orderBy: { canonicalName: 'asc' },
        take: query.limit ?? 48,
        skip: query.offset ?? 0,
      }),
      this.prisma.channel.count({ where }),
    ]);

    const nowPlaying = await this.findNowPlaying(channels.map((channel) => channel.id));
    const items = channels.map((channel) => this.serialize(channel, nowPlaying.get(channel.id) ?? null));

    return {
      items,
      total,
      hasMore: (query.offset ?? 0) + items.length < total,
    };
  }

  async findOne(id: string): Promise<Channel> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw new NotFoundException('Channel not found');
    const nowPlaying = (await this.findNowPlaying([id])).get(id) ?? null;
    return this.serialize(channel, nowPlaying);
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

    const variant = await this.prisma.streamVariant.findFirst({
      where: { channelId: id, isActive: true },
      orderBy: { healthScore: 'desc' },
    });
    if (!variant) throw new NotFoundException('Channel not available');

    return {
      url: this.crypto.decrypt(variant.encryptedLocator),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
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

  private serialize(
    channel: { id: string; name: string; canonicalName: string; country: string | null; categoryId: string | null; logoKey: string | null },
    nowPlaying: NowPlaying | null,
  ): Channel {
    return {
      id: channel.id,
      name: channel.name,
      canonicalName: channel.canonicalName,
      country: channel.country,
      categoryId: channel.categoryId,
      logoUrl: channel.logoKey,
      nowPlaying,
    };
  }
}
