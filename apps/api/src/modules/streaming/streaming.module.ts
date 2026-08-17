import { Module } from '@nestjs/common';
import { ChannelHealthModule } from '../channel-health/channel-health.module';
import { HostValidationCache } from './host-validation.cache';
import { InMemoryStreamSessionStore, StreamSessionStore } from './stream-session.store';
import { StreamSessionGuard } from './stream.guard';
import { StreamingController } from './streaming.controller';
import { StreamingService } from './streaming.service';

@Module({
  imports: [ChannelHealthModule],
  controllers: [StreamingController],
  providers: [
    StreamingService,
    StreamSessionGuard,
    HostValidationCache,
    { provide: StreamSessionStore, useClass: InMemoryStreamSessionStore },
  ],
  exports: [StreamingService],
})
export class StreamingModule {}
