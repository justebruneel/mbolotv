import { Body, ConflictException, Controller, Delete, Get, Headers, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { accessCodeCreateSchema, accessRedeemSchema, type AccessCode, type AccessCodeCreateInput, type AccessRedeemInput, type AccessStatus } from '@mbolo/contracts';
import { getOwnerContext } from '../../common/auth/owner-context';
import { OwnerAuthGuard } from '../../common/auth/owner-auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AccessService } from './access.service';

@Controller('access')
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get('status')
  status(@Headers('x-device-id') deviceId?: string): Promise<AccessStatus> {
    return this.access.status(deviceId);
  }

  @Post('redeem')
  redeem(@Body(new ZodValidationPipe(accessRedeemSchema)) input: AccessRedeemInput, @Headers('x-device-id') deviceId: string | undefined, @Req() request: FastifyRequest): Promise<AccessStatus> {
    if (!deviceId?.trim()) throw new ConflictException('Identifiant appareil manquant');
    return this.access.redeem(input.code, deviceId, request.headers['user-agent'], request.ip);
  }
}

@Controller('owner/access-codes')
@UseGuards(OwnerAuthGuard)
export class OwnerAccessController {
  constructor(private readonly access: AccessService) {}

  @Get()
  list(@Req() request: FastifyRequest): Promise<AccessCode[]> {
    return this.access.list(getOwnerContext(request).userId);
  }

  @Post()
  create(@Req() request: FastifyRequest, @Body(new ZodValidationPipe(accessCodeCreateSchema)) input: AccessCodeCreateInput): Promise<AccessCode> {
    return this.access.create(getOwnerContext(request).userId, input);
  }

  @Delete(':id')
  async revoke(@Req() request: FastifyRequest, @Param('id') id: string): Promise<void> {
    await this.access.revoke(getOwnerContext(request).userId, id);
  }
}
