import { Module } from '@nestjs/common';
import { ChannelHealthModule } from '../channel-health/channel-health.module';
import { ChannelsModule } from '../channels/channels.module';
import { OwnerAuthModule } from '../owner-auth/owner-auth.module';
import { OwnerConsoleController } from './owner-console.controller';
import { OwnerVodController } from './owner-vod.controller';

@Module({
  imports: [OwnerAuthModule, ChannelHealthModule, ChannelsModule],
  controllers: [OwnerConsoleController, OwnerVodController],
})
export class OwnerConsoleModule {}
