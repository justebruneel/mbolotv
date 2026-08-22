import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { Match, MatchListResponse, MatchPlayInput, MatchQuery, PlayResponse } from '@mbolo/contracts';
import { matchPlaySchema, matchQuerySchema } from '@mbolo/contracts';
import { AccessGuard } from '../access/access.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { MatchesService } from './matches.service';

@UseGuards(AccessGuard)
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
    @Headers('x-device-id') deviceId: string | undefined,
  ): Promise<PlayResponse> {
    return this.matchesService.play(id, input, deviceId);
  }
}