import { Controller, Get, Query } from '@nestjs/common';
import type { EpgRangeQuery, EpgRangeResponse } from '@mbolo/contracts';
import { epgRangeQuerySchema } from '@mbolo/contracts';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { EpgService } from './epg.service';

@Controller('epg')
export class EpgController {
  constructor(private readonly epgService: EpgService) {}

  @Get('range')
  range(
    @Query(new ZodValidationPipe(epgRangeQuerySchema)) query: EpgRangeQuery,
  ): Promise<EpgRangeResponse> {
    return this.epgService.range(query);
  }
}
