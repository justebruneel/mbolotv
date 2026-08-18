import { Module } from '@nestjs/common';
import { StorageModule } from '../../common/storage/storage.module';
import { StreamingModule } from '../streaming/streaming.module';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';

@Module({
  imports: [StreamingModule, StorageModule],
  controllers: [ChannelsController],
  providers: [ChannelsService],
})
export class ChannelsModule {}
