import { Injectable } from '@nestjs/common';
import type { EpgEntry, EpgRangeQuery, EpgRangeResponse, Programme, ProgrammeSearchQuery, ProgrammeSearchResponse } from '@mbolo/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';

type ProgrammeRow = {
  id: string;
  channelId: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  startsAt: Date;
  endsAt: Date;
  metadata: unknown | null;
  channel: { id: string; name: string; canonicalName: string; country: string | null; categoryId: string | null; logoKey: string | null };
};

function extractEnriched(metadata: unknown): Partial<Programme> {
  if (!metadata || typeof metadata !== 'object') return {};
  const m = metadata as Record<string, unknown>;
  const tmdb = (m.tmdb as Record<string, unknown> | null) ?? null;
  return {
    type: (m.type as Programme['type']) ?? null,
    posterUrl: (tmdb?.posterUrl as string | null) ?? (m.posterUrl as string | null) ?? null,
    backdropUrl: (tmdb?.backdropUrl as string | null) ?? (m.backdropUrl as string | null) ?? null,
    trailerUrl: (tmdb?.trailerUrl as string | null) ?? null,
    genres: (tmdb?.genres as string[] | null) ?? (m.genres as string[] | null) ?? null,
    year: (tmdb?.year as number | null) ?? null,
    seasonNumber: (m.seasonNumber as number | null) ?? null,
    episodeNumber: (m.episodeNumber as number | null) ?? null,
  };
}

@Injectable()
export class EpgService {
  constructor(private readonly prisma: PrismaService) {}
  async search(query: ProgrammeSearchQuery): Promise<ProgrammeSearchResponse> {
    const where = { title: { contains: query.q, mode: 'insensitive' as const }, channel: { isVisible: true, variants: { some: { isActive: true, OR: [{ healthStatus: null }, { healthStatus: 'OK' }] } }, ...(await this.hiddenCategoryClause()), ...(query.category ? { category: { slug: query.category } } : {}) } };
    const programmes = await this.prisma.epgProgramme.findMany({ where, include: { channel: { select: { id: true, name: true, canonicalName: true, country: true, categoryId: true, logoKey: true } } }, orderBy: [{ startsAt: 'desc' }], take: query.limit });
    return {
      items: programmes.map((programme: ProgrammeRow) => ({
        id: programme.id,
        channelId: programme.channelId,
        title: programme.title,
        description: programme.description,
        imageUrl: programme.imageUrl,
        startsAt: programme.startsAt.toISOString(),
        endsAt: programme.endsAt.toISOString(),
        ...extractEnriched(programme.metadata),
        channel: { id: programme.channel.id, name: programme.channel.name, canonicalName: programme.channel.canonicalName, country: programme.channel.country, categoryId: programme.channel.categoryId, logoUrl: programme.channel.logoKey },
      })),
      total: programmes.length,
    };
  }
  async range(query: EpgRangeQuery): Promise<EpgRangeResponse> {
    const to = query.to ? new Date(query.to) : new Date(Date.now() + 5 * 3_600_000);
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 6 * 3_600_000);
    const programmes = await this.prisma.epgProgramme.findMany({
      where: { startsAt: { lt: to }, endsAt: { gt: from }, channel: { isVisible: true, variants: { some: { isActive: true, OR: [{ healthStatus: null }, { healthStatus: 'OK' }] } }, ...(await this.hiddenCategoryClause()), ...(query.category ? { category: { slug: query.category } } : {}) } },
      include: { channel: { select: { id: true, name: true, canonicalName: true, country: true, categoryId: true, logoKey: true } } },
      orderBy: [{ channelId: 'asc' }, { startsAt: 'asc' }],
      take: 500,
    });
    const programmesByChannel = new Map<string, EpgEntry['programmes']>();
    for (const programme of programmes as unknown as ProgrammeRow[]) {
      const list = programmesByChannel.get(programme.channelId) ?? [];
      list.push({
        id: programme.id,
        channelId: programme.channelId,
        startsAt: programme.startsAt.toISOString(),
        endsAt: programme.endsAt.toISOString(),
        title: programme.title,
        description: programme.description,
        imageUrl: programme.imageUrl,
        ...extractEnriched((programme as unknown as { metadata: unknown }).metadata),
      });
      programmesByChannel.set(programme.channelId, list);
    }
    const items: EpgEntry[] = [];
    for (const programme of programmes as unknown as ProgrammeRow[]) {
      if (items.some((item) => item.channel.id === programme.channel.id)) continue;
      const list = programmesByChannel.get(programme.channelId);
      if (!list) continue;
      items.push({
        channel: { id: programme.channel.id, name: programme.channel.name, canonicalName: programme.channel.canonicalName, country: programme.channel.country, categoryId: programme.channel.categoryId, logoUrl: programme.channel.logoKey },
        programmes: list,
      });
    }
    return { items, from: from.toISOString(), to: to.toISOString() };
  }
  private async hiddenCategoryClause(): Promise<Record<string, unknown>> {
    const hiddenIds = await this.hiddenCategoryIds();
    return hiddenIds.size ? { categoryId: { notIn: [...hiddenIds] } } : {};
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
}
