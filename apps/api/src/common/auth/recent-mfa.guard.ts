import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { getOwnerContext } from './owner-context';

@Injectable()
export class RecentMfaGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    // En développement, la vérification MFA récente est désactivée.
    if (this.config.get<string>('NODE_ENV', 'development') !== 'production') {
      return true;
    }
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const owner = getOwnerContext(request);
    const ttlMinutes = this.config.get<number>('OWNER_REAUTH_TTL_MINUTES', 10);
    const recentSince = Date.now() - ttlMinutes * 60_000;
    if (owner.mfaVerifiedAt.getTime() < recentSince) {
      throw new ForbiddenException('MFA récente requise pour cette action');
    }
    return true;
  }
}