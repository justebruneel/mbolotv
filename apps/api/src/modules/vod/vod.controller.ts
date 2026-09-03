import { Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { VodKind } from '@mbolo/contracts';
import { AccessGuard } from '../access/access.guard';
import { VodService } from './vod.service';

// Catalogue VOD public : mêmes routes que le Worker (/api/vod*), mur
// DeviceGrant identique au live. La lecture (play) reste réservée au Worker
// en production — le proxy HLS/relay-dns vit dans workers/mbolo-tv-api.
@UseGuards(AccessGuard)
@Controller('vod')
export class VodController {
  constructor(private readonly vod: VodService) {}

  @Get()
  list(
    @Query('kind') kind?: string,
    @Query('category') category?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): ReturnType<VodService['list']> {
    return this.vod.list({
      kind: kind === 'MOVIE' || kind === 'SERIES' ? (kind as VodKind) : undefined,
      category: category ?? undefined,
      q: q ?? undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('rows')
  rows(
    @Query('kind') kind?: string,
    @Query('q') q?: string,
    @Query('rows') rows?: string,
    @Query('perRow') perRow?: string,
  ): ReturnType<VodService['rows']> {
    return this.vod.rows({
      kind: kind === 'MOVIE' || kind === 'SERIES' ? (kind as VodKind) : undefined,
      q: q ?? undefined,
      rowsCount: rows ? Number(rows) : undefined,
      perRow: perRow ? Number(perRow) : undefined,
    });
  }

  @Get('hero')
  hero(@Query('kind') kind?: string): ReturnType<VodService['hero']> {
    return this.vod.hero(kind === 'MOVIE' || kind === 'SERIES' ? (kind as VodKind) : undefined);
  }

  @Get('categories')
  categories(@Query('kind') kind?: string): ReturnType<VodService['categories']> {
    return this.vod.categories(kind === 'MOVIE' || kind === 'SERIES' ? (kind as VodKind) : undefined);
  }

  @Get(':id')
  detail(@Param('id') id: string): ReturnType<VodService['detail']> {
    return this.vod.detail(id);
  }

  @Get(':id/episodes')
  episodes(@Param('id') id: string): ReturnType<VodService['episodes']> {
    return this.vod.episodes(id);
  }
}
