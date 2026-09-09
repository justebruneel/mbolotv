import { Controller, Delete, Get, Headers, Param, Put, Query, UseGuards } from '@nestjs/common';
import { AccessGuard } from '../access/access.guard';
import { VodService } from './vod.service';

// Genres du catalogue externe : /api/x/genres (contrat du Worker, ne PAS
// ranger sous /x/titles — le front appelle useExternalGenres sur ce chemin).
@UseGuards(AccessGuard)
@Controller('x')
export class ExternalGenresController {
  constructor(private readonly vod: VodService) {}

  @Get('genres')
  genres(@Query('kind') kind?: string): ReturnType<VodService['listExternalGenres']> {
    return this.vod.listExternalGenres(kind === 'MOVIE' || kind === 'SERIES' ? kind : undefined);
  }
}

// Favoris titres externes par appareil (lecteurs tiers) : miroir des routes
// Worker /api/x/favorites. Chemins disjoints de 'x/titles/:id' (cf.
// ExternalController ci-dessous).
@UseGuards(AccessGuard)
@Controller('x')
export class ExternalFavoritesController {
  constructor(private readonly vod: VodService) {}

  @Get('favorites')
  favorites(@Headers('x-device-id') deviceId: string | undefined): ReturnType<VodService['listExternalFavorites']> {
    return this.vod.listExternalFavorites(deviceId);
  }

  @Put(':id/favorite')
  addFavorite(@Headers('x-device-id') deviceId: string | undefined, @Param('id') id: string): ReturnType<VodService['addExternalFavorite']> {
    return this.vod.addExternalFavorite(deviceId, id);
  }

  @Delete(':id/favorite')
  removeFavorite(@Headers('x-device-id') deviceId: string | undefined, @Param('id') id: string): ReturnType<VodService['removeExternalFavorite']> {
    return this.vod.removeExternalFavorite(deviceId, id);
  }
}

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
    @Query('sort') sort?: 'recent' | 'year' | 'title',
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): ReturnType<VodService['listExternalTitles']> {
    return this.vod.listExternalTitles({
      q: q ?? undefined,
      kind: kind === 'MOVIE' || kind === 'SERIES' ? kind : undefined,
      genre: genre?.trim() ? genre.trim() : undefined,
      sort: sort === 'year' || sort === 'title' ? sort : undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get(':id')
  detail(@Param('id') id: string): ReturnType<VodService['externalTitleDetail']> {
    return this.vod.externalTitleDetail(id);
  }
}
