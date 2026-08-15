import { Controller, Get, Query } from '@nestjs/common';
import type { ProgrammeSearchQuery, ProgrammeSearchResponse } from '@mbolo/contracts';
import { programmeSearchQuerySchema } from '@mbolo/contracts';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { EpgService } from './epg.service';

@Controller('programmes')
export class ProgrammesController {
  constructor(private readonly epgService: EpgService) {}

  @Get('search')
  search(
    @Query(new ZodValidationPipe(programmeSearchQuerySchema)) query: ProgrammeSearchQuery,
  ): Promise<ProgrammeSearchResponse> {
    return this.epgService.search(query);
  }
}
