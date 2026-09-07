import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AccessGuard } from '../access/access.guard';
import { VodService } from './vod.service';

// Titres externes publics (lecteurs tiers) : mêmes routes que le Worker
// (/api/x/titles*). La résolution/lecture reste côté Worker (/api/x/play).
@UseGuards(AccessGuard)
@Controller('x/titles')
export class ExternalController {
  constructor(private readonly vod: VodService) {}

  @Get()
  list(
    @Query('q') q?: string,
    @Query('kind') kind?: 'MOVIE' | 'SERIES',
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): ReturnType<VodService['listExternalTitles']> {
    return this.vod.listExternalTitles({
      q: q ?? undefined,
      kind: kind === 'MOVIE' || kind === 'SERIES' ? kind : undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get(':id')
  detail(@Param('id') id: string): ReturnType<VodService['externalTitleDetail']> {
    return this.vod.externalTitleDetail(id);
  }
}
