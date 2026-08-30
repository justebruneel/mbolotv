import { Controller, Delete, Get, Headers, Param, Put, UseGuards } from '@nestjs/common';
import { AccessGuard } from '../access/access.guard';
import { FavoritesService } from './favorites.service';

// Même garde que le catalogue : seuls les appareils avec un code d'accès
// actif lisent ou écrivent des favoris.
@UseGuards(AccessGuard)
@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  list(@Headers('x-device-id') deviceId: string | undefined) {
    return this.favorites.list(deviceId);
  }

  @Put(':channelId')
  add(@Headers('x-device-id') deviceId: string | undefined, @Param('channelId') channelId: string) {
    return this.favorites.add(deviceId, channelId);
  }

  @Delete(':channelId')
  remove(@Headers('x-device-id') deviceId: string | undefined, @Param('channelId') channelId: string) {
    return this.favorites.remove(deviceId, channelId);
  }
}
