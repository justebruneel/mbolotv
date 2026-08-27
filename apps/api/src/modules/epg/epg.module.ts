import { Module } from '@nestjs/common';
import { EpgController } from './epg.controller';
import { EpgService } from './epg.service';
import { EpgImportService } from './epg-import.service';
import { ProgrammesController } from './programmes.controller';
import { EpgOrchestrator } from './epg-orchestrator.service';
import { MetadataModule } from '../metadata/metadata.module';

@Module({
  imports: [MetadataModule],
  controllers: [EpgController, ProgrammesController],
  providers: [EpgService, EpgImportService, EpgOrchestrator],
  exports: [EpgImportService, EpgOrchestrator],
})
export class EpgModule {}
