import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AccessService } from './access.service';

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(private readonly access: AccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const deviceId = request.headers['x-device-id'];
    const normalized = Array.isArray(deviceId) ? deviceId[0] : deviceId;
    const status = await this.access.status(normalized);
    if (!status.active) throw new ForbiddenException('Un code d’accès actif est requis');
    return true;
  }
}
