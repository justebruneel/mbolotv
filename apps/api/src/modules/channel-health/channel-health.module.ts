import { Module } from '@nestjs/common';
import { HealthCheckService } from './channel-health.service';

@Module({
  providers: [HealthCheckService],
  exports: [HealthCheckService],
})
export class ChannelHealthModule {}
