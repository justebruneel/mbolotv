import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { ChannelsModule } from '../channels/channels.module';
import { FavoritesController } from './favorites.controller';
import { FavoritesService } from './favorites.service';

@Module({
  imports: [AccessModule, ChannelsModule],
  controllers: [FavoritesController],
  providers: [FavoritesService],
})
export class FavoritesModule {}
