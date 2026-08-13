import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ownerLoginSchema,
  ownerMfaVerifySchema,
  type OwnerLoginInput,
  type OwnerMe,
  type OwnerMfaVerifyInput,
  type OwnerSession,
} from '@mbolo/contracts';
import { OwnerAuthGuard } from '../../common/auth/owner-auth.guard';
import { getOwnerContext, OwnerContext } from '../../common/auth/owner-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { OwnerAuthService } from './owner-auth.service';

interface ChallengeResponse {
  challengeToken: string;
}

interface SessionInfo {
  me: OwnerMe;
  sessionId: string;
}

@Controller('owner/auth')
export class OwnerAuthController {
  constructor(private readonly ownerAuthService: OwnerAuthService) {}

  @Post('login')
  login(
    @Body(new ZodValidationPipe(ownerLoginSchema)) input: OwnerLoginInput,
    @Req() request: FastifyRequest,
  ): Promise<ChallengeResponse> {
    return this.ownerAuthService.login(input, request.ip, request.headers['user-agent']);
  }

  @Post('mfa/verify')
  mfaVerify(
    @Body(new ZodValidationPipe(ownerMfaVerifySchema)) input: OwnerMfaVerifyInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OwnerMe> {
    return this.ownerAuthService.mfaVerify(
      input,
      request.ip,
      request.headers['user-agent'],
      reply,
    );
  }

  @Post('logout')
  logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.ownerAuthService.logout(request, reply);
  }

  @UseGuards(OwnerAuthGuard)
  @Post('reauthenticate')
  reauthenticate(
    @Body(new ZodValidationPipe(ownerMfaVerifySchema.omit({ challengeToken: true }))) input: { totpCode: string },
    @Req() request: FastifyRequest,
  ) {
    return this.ownerAuthService.reauthenticate(input.totpCode, request, request.ip);
  }

  @UseGuards(OwnerAuthGuard)
  @Get('session')
  session(@Req() request: FastifyRequest): Promise<SessionInfo> {
    return this.ownerAuthService.currentSession(request);
  }

  @UseGuards(OwnerAuthGuard)
  @Get('sessions')
  sessions(@Req() request: FastifyRequest): Promise<OwnerSession[]> {
    const owner: OwnerContext = getOwnerContext(request);
    return this.ownerAuthService.listSessions(owner.userId, owner.sessionId);
  }

  @UseGuards(OwnerAuthGuard)
  @Delete('sessions/:id')
  revokeSession(@Req() request: FastifyRequest, @Param('id') sessionId: string) {
    const owner: OwnerContext = getOwnerContext(request);
    return this.ownerAuthService.revokeSession(owner.userId, sessionId);
  }
}