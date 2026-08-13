import { Injectable, NotFoundException } from '@nestjs/common';
import type { Match, MatchListResponse, MatchQuery } from '@mbolo/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class MatchesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: MatchQuery): Promise<MatchListResponse> {
    const where = {
      ...(query.state ? { state: query.state } : {}),
      ...(query.sport ? { sport: query.sport } : {}),
      ...(query.from ? { startsAt: { gte: new Date(query.from) } } : {}),
      ...(query.to ? { startsAt: { lte: new Date(query.to) } } : {}),
    };

    const matches = await this.prisma.match.findMany({
      where,
      orderBy: [{ startsAt: 'asc' }],
      take: 200,
    });

    return {
      items: matches.map((match) => this.serialize(match)),
      total: matches.length,
    };
  }

  async findOne(id: string): Promise<Match> {
    const match = await this.prisma.match.findUnique({ where: { id } });
    if (!match) throw new NotFoundException('Match not found');
    return this.serialize(match);
  }

  private serialize(match: {
    id: string;
    sport: string;
    competition: string;
    homeTeam: string;
    awayTeam: string;
    startsAt: Date;
    state: string;
  }): Match {
    return {
      id: match.id,
      sport: match.sport,
      competition: match.competition,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      startsAt: match.startsAt.toISOString(),
      state: match.state as Match['state'],
    };
  }
}
