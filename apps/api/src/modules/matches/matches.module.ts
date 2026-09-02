import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { StreamingModule } from '../streaming/streaming.module';
import { MatchesController } from './matches.controller';
import { MatchesDiscoveryService } from './matches-discovery.service';
import { MatchesService } from './matches.service';
import { FootballScheduleService } from './football-schedule.service';

@Module({
  imports: [StreamingModule, AccessModule],
  controllers: [MatchesController],
  providers: [MatchesService, MatchesDiscoveryService, FootballScheduleService],
})
export class MatchesModule {}