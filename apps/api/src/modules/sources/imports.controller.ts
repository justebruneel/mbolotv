import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { ImportRun, ImportRunListResponse } from '@mbolo/contracts';
import { getOwnerContext } from '../../common/auth/owner-context';
import { OwnerAuthGuard } from '../../common/auth/owner-auth.guard';
import { SourcesService } from './sources.service';

@UseGuards(OwnerAuthGuard)
@Controller('owner/imports')
export class ImportsController {
  constructor(private readonly sourcesService: SourcesService) {}

  @Get()
  list(@Req() request: FastifyRequest): Promise<ImportRunListResponse> {
    return this.sourcesService.listImports(getOwnerContext(request).userId);
  }

  @Get(':id')
  detail(@Req() request: FastifyRequest, @Param('id') id: string): Promise<ImportRun> {
    return this.sourcesService.importDetail(getOwnerContext(request).userId, id);
  }
}
