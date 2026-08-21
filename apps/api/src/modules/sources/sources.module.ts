import { Module } from '@nestjs/common';
import { OwnerAuthModule } from '../owner-auth/owner-auth.module';
import { QueueModule } from '../../common/queue/queue.module';
import { StorageModule } from '../../common/storage/storage.module';
import { EpgModule } from '../epg/epg.module';
import { ImportCancellationRegistry } from './import-cancellation';
import { ImportProcessor } from './import.processor';
import { ImportsController } from './imports.controller';
import { InternalJobsController } from './internal-jobs.controller';
import { SourcesController } from './sources.controller';
import { SourcesService } from './sources.service';

@Module({
  imports: [QueueModule, OwnerAuthModule, StorageModule, EpgModule],
  controllers: [SourcesController, ImportsController, InternalJobsController],
  providers: [ImportCancellationRegistry, SourcesService, ImportProcessor],
})
export class SourcesModule {}
