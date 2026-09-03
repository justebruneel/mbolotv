import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { sourceCreateSchema, sourceImportSchema, sourceUpdateSchema, type ConnectTestResponse, type ImportRun, type ImportScope, type SourceCreateInput, type SourceCredentials, type SourceDetail, type SourceImportInput, type SourceResponse, type SourceUpdateInput } from '@mbolo/contracts';
import { getOwnerContext, OwnerContext } from '../../common/auth/owner-context';
import { OwnerAuthGuard } from '../../common/auth/owner-auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SourcesService } from './sources.service';

@Controller('owner/sources')
export class SourcesController {
  constructor(private readonly sourcesService: SourcesService) {}
  @UseGuards(OwnerAuthGuard) @Get() list(@Req() request: FastifyRequest): Promise<SourceResponse[]> { return this.sourcesService.list(this.ownerOf(request).userId); }
  @UseGuards(OwnerAuthGuard) @Get(':id/test') test(@Req() request: FastifyRequest, @Param('id') id: string): Promise<ConnectTestResponse> { return this.sourcesService.test(this.ownerOf(request).userId, id); }
  @UseGuards(OwnerAuthGuard) @Get(':id/credentials') credentials(@Req() request: FastifyRequest, @Param('id') id: string): Promise<SourceCredentials> { return this.sourcesService.credentials(this.ownerOf(request).userId, id); }
  @UseGuards(OwnerAuthGuard) @Get(':id') detail(@Req() request: FastifyRequest, @Param('id') id: string): Promise<SourceDetail> { return this.sourcesService.detail(this.ownerOf(request).userId, id); }
  @UseGuards(OwnerAuthGuard) @Post() create(@Req() request: FastifyRequest, @Body(new ZodValidationPipe(sourceCreateSchema)) input: SourceCreateInput): Promise<SourceResponse> { return this.sourcesService.create(this.ownerOf(request).userId, input); }
  @UseGuards(OwnerAuthGuard) @Patch(':id') update(@Req() request: FastifyRequest, @Param('id') id: string, @Body(new ZodValidationPipe(sourceUpdateSchema)) input: SourceUpdateInput): Promise<SourceResponse> { return this.sourcesService.update(this.ownerOf(request).userId, id, input); }
  @UseGuards(OwnerAuthGuard) @Delete(':id') @HttpCode(HttpStatus.NO_CONTENT) remove(@Req() request: FastifyRequest, @Param('id') id: string): Promise<void> { return this.sourcesService.remove(this.ownerOf(request).userId, id); }
  @UseGuards(OwnerAuthGuard) @Post(':id/import') importNow(@Req() request: FastifyRequest, @Param('id') id: string, @Body(new ZodValidationPipe(sourceImportSchema.optional())) input?: SourceImportInput): Promise<ImportRun> { return this.sourcesService.importNow(this.ownerOf(request).userId, id, input?.scope ?? 'all'); }
  @UseGuards(OwnerAuthGuard) @Post(':id/playlist') uploadPlaylist(@Req() request: FastifyRequest, @Param('id') id: string, @Query('scope') scope?: string): Promise<SourceResponse> {
    const raw = request.body;
    const body = raw instanceof Readable ? raw : Buffer.isBuffer(raw) ? Readable.from(raw) : null;
    if (!body) throw new BadRequestException('Corps de requête attendu (flux .m3u)');
    const parsed = sourceImportSchema.shape.scope.safeParse(scope ?? undefined);
    const normalized: ImportScope = parsed.success && parsed.data ? parsed.data : 'all';
    return this.sourcesService.replacePlaylistStream(this.ownerOf(request).userId, id, body, normalized);
  }
  private ownerOf(request: FastifyRequest): OwnerContext { return getOwnerContext(request); }
}
