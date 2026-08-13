import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type { ImportRun, ImportRunListResponse } from '@mbolo/contracts';
import { OwnerAuthGuard } from '../../common/auth/owner-auth.guard';
import { SourcesService } from './sources.service';

@UseGuards(OwnerAuthGuard)
@Controller('owner/imports')
export class ImportsController {
  constructor(private readonly sourcesService: SourcesService) {}

  @Get()
  list(): Promise<ImportRunListResponse> {
    return this.sourcesService.listImports();
  }

  @Get(':id')
  detail(@Param('id') id: string): Promise<ImportRun> {
    return this.sourcesService.importDetail(id);
  }
}