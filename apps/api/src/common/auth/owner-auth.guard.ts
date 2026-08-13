import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { OwnerGuard as OwnerSessionValidator } from './owner-context';

@Injectable()
export class OwnerAuthGuard implements CanActivate {
  constructor(private readonly validator: OwnerSessionValidator) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    await this.validator.validateRequest(request);
    return true;
  }
}