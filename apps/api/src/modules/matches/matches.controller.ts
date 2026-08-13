import { Controller, Get, Param, Query } from '@nestjs/common';
import type { Match, MatchListResponse, MatchQuery } from '@mbolo/contracts';
import { matchQuerySchema } from '@mbolo/contracts';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { MatchesService } from './matches.service';

@Controller('matches')
export class MatchesController {
  constructor(private readonly matchesService: MatchesService) {}

  @Get()
  list(@Query(new ZodValidationPipe(matchQuerySchema)) query: MatchQuery): Promise<MatchListResponse> {
    return this.matchesService.list(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<Match> {
    return this.matchesService.findOne(id);
  }
}
