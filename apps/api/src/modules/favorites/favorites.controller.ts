import { Controller, Delete, Get, Headers, Param, Put } from '@nestjs/common';
import { FavoritesService } from './favorites.service';

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
