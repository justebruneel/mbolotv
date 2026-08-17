import { Module } from '@nestjs/common';
import { StreamingModule } from '../streaming/streaming.module';
import { MatchesController } from './matches.controller';
import { MatchesDiscoveryService } from './matches-discovery.service';
import { MatchesService } from './matches.service';

@Module({
  imports: [StreamingModule],
  controllers: [MatchesController],
  providers: [MatchesService, MatchesDiscoveryService],
})
export class MatchesModule {}