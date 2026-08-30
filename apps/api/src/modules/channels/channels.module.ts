import { Module } from '@nestjs/common';
import { StorageModule } from '../../common/storage/storage.module';
import { AccessModule } from '../access/access.module';
import { StreamingModule } from '../streaming/streaming.module';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';

@Module({
  imports: [AccessModule, StreamingModule, StorageModule],
  controllers: [ChannelsController],
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
