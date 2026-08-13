import { Injectable } from '@nestjs/common';
import type { EpgEntry, EpgRangeQuery, EpgRangeResponse } from '@mbolo/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class EpgService {
  constructor(private readonly prisma: PrismaService) {}

  async range(query: EpgRangeQuery): Promise<EpgRangeResponse> {
    const to = query.to ? new Date(query.to) : new Date(Date.now() + 5 * 3_600_000);
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 6 * 3_600_000);

    const channels = await this.prisma.channel.findMany({
      where: query.category ? { category: { slug: query.category } } : {},
      orderBy: { canonicalName: 'asc' },
      take: 100,
    });

    const programmes = await this.prisma.epgProgramme.findMany({
      where: {
        channelId: { in: channels.map((channel) => channel.id) },
        startsAt: { lt: to },
        endsAt: { gt: from },
      },
      orderBy: { startsAt: 'asc' },
    });

    const programmesByChannel = new Map<string, EpgEntry['programmes']>();
    for (const programme of programmes) {
      const list = programmesByChannel.get(programme.channelId) ?? [];
      list.push({
        id: programme.id,
        channelId: programme.channelId,
        startsAt: programme.startsAt.toISOString(),
        endsAt: programme.endsAt.toISOString(),
        title: programme.title,
        description: programme.description,
      });
      programmesByChannel.set(programme.channelId, list);
    }

    const items: EpgEntry[] = channels
      .filter((channel) => programmesByChannel.has(channel.id))
      .map((channel) => ({
        channel: {
          id: channel.id,
          name: channel.name,
          canonicalName: channel.canonicalName,
          country: channel.country,
          categoryId: channel.categoryId,
          logoUrl: channel.logoKey,
        },
        programmes: programmesByChannel.get(channel.id)!,
      }));

    return { items, from: from.toISOString(), to: to.toISOString() };
  }
}
