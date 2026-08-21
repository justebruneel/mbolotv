import { Module } from '@nestjs/common';
import { ChannelHealthModule } from '../channel-health/channel-health.module';
import { OwnerAuthModule } from '../owner-auth/owner-auth.module';
import { OwnerConsoleController } from './owner-console.controller';

@Module({
  imports: [OwnerAuthModule, ChannelHealthModule],
  controllers: [OwnerConsoleController],
})
export class OwnerConsoleModule {}
