import { Injectable, NotFoundException } from '@nestjs/common';
import type { Match, MatchChannel, MatchListResponse, MatchPlayInput, MatchQuery, PlayResponse } from '@mbolo/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StreamingService } from '../streaming/streaming.service';

interface VariantWithSource {
  id: string;
  healthScore: number;
  healthStatus: string | null;
  isActive: boolean;
  encryptedLocator: Uint8Array;
  sourceId: string;
  channel: { id: string; name: string; logoKey: string | null };
  source: { status: string; priority: number } | null;
}

interface MatchWithVariants {
  id: string;
  sport: string;
  competition: string;
  homeTeam: string;
  awayTeam: string;
  startsAt: Date;
  endsAt: Date | null;
  state: string;
  variants: VariantWithSource[];
}

interface MatchRow {
  id: string;
  sport: string;
  competition: string;
  homeTeam: string;
  awayTeam: string;
  startsAt: Date;
  endsAt: Date | null;
  state: string;
  matchStreams: Array<{
    streamVariant: {
      id: string;
      healthScore: number;
      healthStatus: string | null;
      isActive: boolean;
      encryptedLocator: Uint8Array;
      sourceId: string;
      channel: { id: string; name: string; logoKey: string | null };
    };
  }>;
}

const VARIANT_SELECT = {
  id: true,
  healthScore: true,
  healthStatus: true,
  isActive: true,
  encryptedLocator: true,
  sourceId: true,
  channel: { select: { id: true, name: true, logoKey: true } },
} as const;

@Injectable()
export class MatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly streaming: StreamingService,
  ) {}

  async list(query: MatchQuery): Promise<MatchListResponse> {
    const where = {
      ...(query.state ? { state: query.state } : {}),
      ...(query.sport ? { sport: query.sport } : {}),
      ...(query.from ? { startsAt: { gte: new Date(query.from) } } : {}),
      ...(query.to ? { startsAt: { lte: new Date(query.to) } } : {}),
    };

    const rows = await this.prisma.match.findMany({
      where,
      orderBy: [{ startsAt: 'asc' }],
      take: 200,
      include: { matchStreams: { include: { streamVariant: { select: VARIANT_SELECT } } } },
    });

    const sources = await this.loadSources(rows);

    return {
      items: rows.map((row) => this.serialize(this.toMatchWithVariants(row, sources))),
      total: rows.length,
    };
  }

  async findOne(id: string): Promise<Match> {
    const match = await this.findMatchOrThrow(id);
    return this.serialize(match);
  }

  /** Ouvre la lecture du meilleur flux disponible pour un match (ou une chaîne précise). */
  async play(id: string, input: MatchPlayInput): Promise<PlayResponse> {
    const match = await this.findMatchOrThrow(id);

    const variants = match.variants
      .filter(
        (variant) =>
          variant.isActive &&
          variant.source?.status !== 'DISABLED' &&
          (!input.channelId || variant.channel.id === input.channelId),
      )
      .sort(
        (a, b) =>
          b.healthScore - a.healthScore ||
          (a.source?.priority ?? 100) - (b.source?.priority ?? 100),
      );

    if (variants.length === 0) {
      throw new NotFoundException('Aucun flux disponible pour ce match');
    }

    const variant = variants.find((item) => item.healthStatus !== 'DOWN') ?? variants[0];
    return this.streaming.openSession(match.id, variant);
  }

  private async findMatchOrThrow(id: string): Promise<MatchWithVariants> {
    const row = await this.prisma.match.findUnique({
      where: { id },
      include: { matchStreams: { include: { streamVariant: { select: VARIANT_SELECT } } } },
    });
    if (!row) throw new NotFoundException('Match not found');
    const sources = await this.loadSources([row]);
    return this.toMatchWithVariants(row, sources);
  }

  /** Charge les sources associées aux variantes, en tolérant les orphelins (base inconsistante). */
  private async loadSources(rows: MatchRow[]): Promise<Map<string, { status: string; priority: number }>> {
    const sourceIds = [
      ...new Set(rows.flatMap((row) => row.matchStreams.map((stream) => stream.streamVariant.sourceId))),
    ];
    if (sourceIds.length === 0) return new Map();
    const sources = await this.prisma.source.findMany({
      where: { id: { in: sourceIds } },
      select: { id: true, status: true, priority: true },
    });
    return new Map(sources.map((source) => [source.id, source]));
  }

  private toMatchWithVariants(row: MatchRow, sources: Map<string, { status: string; priority: number }>): MatchWithVariants {
    return {
      id: row.id,
      sport: row.sport,
      competition: row.competition,
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      state: row.state,
      variants: row.matchStreams.map((stream) => ({
        ...stream.streamVariant,
        source: sources.get(stream.streamVariant.sourceId) ?? null,
      })),
    };
  }

  private serialize(match: MatchWithVariants): Match {
    const byChannel = new Map<string, MatchChannel>();
    for (const variant of match.variants) {
      if (!variant.isActive || variant.source?.status === 'DISABLED') continue;
      const channel = variant.channel;
      const entry = byChannel.get(channel.id);
      if (entry) {
        entry.streamCount += 1;
        entry.bestHealth = Math.max(entry.bestHealth ?? 0, variant.healthScore);
      } else {
        byChannel.set(channel.id, {
          id: channel.id,
          name: channel.name,
          logoUrl: channel.logoKey,
          streamCount: 1,
          bestHealth: variant.healthScore,
        });
      }
    }

    return {
      id: match.id,
      sport: match.sport,
      competition: match.competition,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      startsAt: match.startsAt.toISOString(),
      endsAt: match.endsAt ? match.endsAt.toISOString() : null,
      state: match.state as Match['state'],
      channels: [...byChannel.values()],
    };
  }
}