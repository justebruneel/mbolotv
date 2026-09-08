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
    @Query('genre') genre?: string,
    @Query('sort') sort?: 'recent' | 'year',
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): ReturnType<VodService['listExternalTitles']> {
    return this.vod.listExternalTitles({
      q: q ?? undefined,
      kind: kind === 'MOVIE' || kind === 'SERIES' ? kind : undefined,
      genre: genre?.trim() ? genre.trim() : undefined,
      sort: sort === 'year' ? 'year' : undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('genres')
  genres(@Query('kind') kind?: string): ReturnType<VodService['listExternalGenres']> {
    return this.vod.listExternalGenres(kind === 'MOVIE' || kind === 'SERIES' ? kind : undefined);
  }

  @Get(':id')
  detail(@Param('id') id: string): ReturnType<VodService['externalTitleDetail']> {
    return this.vod.externalTitleDetail(id);
  }
}
