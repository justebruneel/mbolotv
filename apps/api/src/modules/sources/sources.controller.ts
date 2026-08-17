import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  sourceCreateSchema,
  sourceUpdateSchema,
  type ConnectTestResponse,
  type ImportRun,
  type SourceCreateInput,
  type SourceDetail,
  type SourceResponse,
  type SourceUpdateInput,
} from '@mbolo/contracts';
import { getOwnerContext, OwnerContext } from '../../common/auth/owner-context';
import { OwnerAuthGuard } from '../../common/auth/owner-auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SourcesService } from './sources.service';

@Controller('owner/sources')
export class SourcesController {
  constructor(private readonly sourcesService: SourcesService) {}

  @UseGuards(OwnerAuthGuard)
  @Get()
  list(@Req() request: FastifyRequest): Promise<SourceResponse[]> {
    return this.sourcesService.list(this.ownerOf(request).userId);
  }

  @UseGuards(OwnerAuthGuard)
  @Get(':id/test')
  test(@Req() request: FastifyRequest, @Param('id') id: string): Promise<ConnectTestResponse> {
    return this.sourcesService.test(this.ownerOf(request).userId, id);
  }

  @UseGuards(OwnerAuthGuard)
  @Get(':id')
  detail(@Req() request: FastifyRequest, @Param('id') id: string): Promise<SourceDetail> {
    return this.sourcesService.detail(this.ownerOf(request).userId, id);
  }

  @UseGuards(OwnerAuthGuard)
  @Post()
  create(
    @Req() request: FastifyRequest,
    @Body(new ZodValidationPipe(sourceCreateSchema)) input: SourceCreateInput,
  ): Promise<SourceResponse> {
    return this.sourcesService.create(this.ownerOf(request).userId, input);
  }

  @UseGuards(OwnerAuthGuard)
  @Patch(':id')
  update(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(sourceUpdateSchema)) input: SourceUpdateInput,
  ): Promise<SourceResponse> {
    return this.sourcesService.update(this.ownerOf(request).userId, id, input);
  }

  @UseGuards(OwnerAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.sourcesService.remove(this.ownerOf(request).userId, id);
  }

  @UseGuards(OwnerAuthGuard)
  @Post(':id/import')
  importNow(@Req() request: FastifyRequest, @Param('id') id: string): Promise<ImportRun> {
    return this.sourcesService.importNow(this.ownerOf(request).userId, id);
  }

  /**
   * Téléversement d'un fichier .m3u (corps brut, application/octet-stream).
   * Le fichier remplace la connexion existante et l'import démarre aussitôt.
   */
  @UseGuards(OwnerAuthGuard)
  @Post(':id/playlist')
  uploadPlaylist(@Req() request: FastifyRequest, @Param('id') id: string): Promise<SourceResponse> {
    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      throw new BadRequestException('Corps de requête attendu (fichier .m3u)');
    }
    return this.sourcesService.replacePlaylist(this.ownerOf(request).userId, id, body);
  }

  private ownerOf(request: FastifyRequest): OwnerContext {
    return getOwnerContext(request);
  }
}