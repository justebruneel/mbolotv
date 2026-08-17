import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { Match, MatchListResponse, MatchPlayInput, MatchQuery, PlayResponse } from '@mbolo/contracts';
import { matchPlaySchema, matchQuerySchema } from '@mbolo/contracts';
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

  @Post(':id/play')
  play(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(matchPlaySchema)) input: MatchPlayInput,
  ): Promise<PlayResponse> {
    return this.matchesService.play(id, input);
  }
}