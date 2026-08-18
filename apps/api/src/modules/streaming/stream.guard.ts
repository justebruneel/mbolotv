import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RateLimiterService } from '../../common/rate-limit/rate-limiter.service';
import { StreamContext, StreamingService } from './streaming.service';

const SESSION_LIMIT = 900;
const SESSION_WINDOW_MS = 60_000;
const IP_LIMIT = 1800;
const IP_WINDOW_MS = 60_000;

@Injectable()
export class StreamSessionGuard implements CanActivate {
  constructor(private readonly streamingService: StreamingService, private readonly rateLimiter: RateLimiterService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest & { streamContext?: StreamContext }>();
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const session = await this.streamingService.assertSession(sessionId);
    this.assertRateLimited(context, `stream:session:${sessionId}`, SESSION_LIMIT, SESSION_WINDOW_MS);
    this.assertRateLimited(context, `stream:ip:${request.ip}`, IP_LIMIT, IP_WINDOW_MS);
    request.streamContext = { session, sessionId };
    return true;
  }
  private assertRateLimited(context: ExecutionContext, key: string, limit: number, windowMs: number): void {
    const result = this.rateLimiter.check(key, limit, windowMs);
    if (!result.allowed) { const reply = context.switchToHttp().getResponse<FastifyReply>(); reply.header('retry-after', String(result.retryAfterSeconds)); throw new HttpException('Trop de requêtes', 429); }
  }
}
