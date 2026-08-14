import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { OwnerGuard as OwnerSessionValidator } from './owner-context';

@Injectable()
export class OwnerAuthGuard implements CanActivate {
  constructor(private readonly validator: OwnerSessionValidator) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    await this.validator.validateRequest(
      http.getRequest<FastifyRequest>(),
      http.getResponse<FastifyReply>(),
    );
    return true;
  }
}
