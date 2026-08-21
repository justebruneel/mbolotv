import { Module } from '@nestjs/common';
import { EpgController } from './epg.controller';
import { EpgService } from './epg.service';
import { EpgImportService } from './epg-import.service';
import { ProgrammesController } from './programmes.controller';

@Module({
  controllers: [EpgController, ProgrammesController],
  providers: [EpgService, EpgImportService],
  exports: [EpgImportService],
})
export class EpgModule {}
