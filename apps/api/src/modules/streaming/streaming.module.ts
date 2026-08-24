import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { ChannelHealthModule } from '../channel-health/channel-health.module';
import { HostValidationCache } from './host-validation.cache';
import { InMemoryStreamSessionStore, StreamSessionStore } from './stream-session.store';
import { PlaylistCache } from './playlist-cache';
import { StreamSessionGuard } from './stream.guard';
import { StreamingController } from './streaming.controller';
import { StreamingService } from './streaming.service';

const sessionStoreProvider = {
  provide: StreamSessionStore,
  useFactory: () => new InMemoryStreamSessionStore(),
};

@Module({
  imports: [ChannelHealthModule, AccessModule],
  controllers: [StreamingController],
  providers: [StreamingService, StreamSessionGuard, HostValidationCache, PlaylistCache, sessionStoreProvider],
  exports: [StreamingService],
})
export class StreamingModule {}
