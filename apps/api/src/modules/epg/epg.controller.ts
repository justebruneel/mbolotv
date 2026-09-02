import { Controller, Get, Post, Query } from '@nestjs/common';
import type { EpgRangeQuery, EpgRangeResponse } from '@mbolo/contracts';
import { epgRangeQuerySchema } from '@mbolo/contracts';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { EpgImportService, type EpgImportResult } from './epg-import.service';
import { EpgOrchestrator } from './epg-orchestrator.service';
import { EpgService } from './epg.service';
import { MetadataService } from '../metadata/metadata.service';

@Controller('epg')
export class EpgController {
  constructor(
    private readonly epgService: EpgService,
    private readonly epgImportService: EpgImportService,
    private readonly orchestrator: EpgOrchestrator,
    private readonly metadata: MetadataService,
  ) {}

  @Get('range')
  range(
    @Query(new ZodValidationPipe(epgRangeQuerySchema)) query: EpgRangeQuery,
  ): Promise<EpgRangeResponse> {
    return this.epgService.range(query);
  }

  @Get('featured')
  featured(): Promise<unknown> {
    return this.orchestrator.getFeaturedAuto(5);
  }

  @Get('providers')
  providers(): Promise<{ providers: string[]; metadataEnabled: boolean }> {
    return Promise.resolve({
      providers: ['xtream', 'xmltvfr', 'iptv-epg.org', 'globetvapp'],
      metadataEnabled: this.metadata.isEnabled(),
    });
  }

  @Post('import')
  importNow(): Promise<EpgImportResult> {
    return this.epgImportService.run();
  }
}
