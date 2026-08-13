import { Module } from '@nestjs/common';
import { OwnerAuthModule } from '../owner-auth/owner-auth.module';
import { QueueModule } from '../../common/queue/queue.module';
import { ImportProcessor } from './import.processor';
import { ImportsController } from './imports.controller';
import { SourcesController } from './sources.controller';
import { SourcesService } from './sources.service';

@Module({
  imports: [QueueModule, OwnerAuthModule],
  controllers: [SourcesController, ImportsController],
  providers: [SourcesService, ImportProcessor],
})
export class SourcesModule {}