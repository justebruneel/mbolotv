import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { JwtService, SessionJwtPayload } from '../jwt/jwt.service';
import { PrismaService } from '../prisma/prisma.service';

export const OWNER_SESSION_COOKIE = 'mbolo_owner_session';

export interface OwnerContext {
  userId: string;
  email: string;
  sessionId: string;
  expiresAt: Date;
}

export function getOwnerContext(request: FastifyRequest): OwnerContext {
  return (request as FastifyRequest & { ownerContext?: OwnerContext }).ownerContext!;
}

@Injectable()
export class OwnerGuard {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async validateRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies?.[OWNER_SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('Session manquante');

    const payload = await this.jwt.verify<SessionJwtPayload>(token);
    if (payload.purpose !== 'owner-session' || payload.role !== 'OWNER' || !payload.jti) {
      throw new UnauthorizedException('Session invalide');
    }

    const absoluteTtlHours = this.config.get<number>('OWNER_SESSION_ABSOLUTE_TTL_HOURS', 8);
    const issuedAt = payload.iat ?? Math.floor(Date.now() / 1000);
    if (Date.now() - issuedAt * 1000 > absoluteTtlHours * 3_600_000) {
      throw new UnauthorizedException('Session expirée');
    }

    const session = await this.prisma.ownerSession.findUnique({
      where: { id: payload.jti },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.user.role !== 'OWNER') {
      throw new UnauthorizedException('Session invalide ou révoquée');
    }

    const ttlMinutes = this.config.get<number>('OWNER_SESSION_TTL_MINUTES', 15);
    const ttlMs = ttlMinutes * 60_000;
    const now = Date.now();
    const expMs = (payload.exp ?? now) * 1000;

    if (expMs - now < ttlMs / 2) {
      const renewed = await this.jwt.sign(
        {
          purpose: 'owner-session',
          sub: session.userId,
          email: session.user.email,
          role: 'OWNER',
          jti: session.id,
        },
        ttlMinutes * 60,
        payload.iat,
      );
      this.setSessionCookie(reply, renewed, ttlMinutes);
      await this.prisma.ownerSession.update({
        where: { id: session.id },
        data: { expiresAt: new Date(now + ttlMs) },
      });
    }

    (request as FastifyRequest & { ownerContext?: OwnerContext }).ownerContext = {
      userId: session.userId,
      email: session.user.email,
      sessionId: session.id,
      expiresAt: new Date(Math.max(expMs, now + ttlMs)),
    };
  }

  private setSessionCookie(reply: FastifyReply, token: string, ttlMinutes: number): void {
    reply.setCookie(OWNER_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.get<string>('NODE_ENV', 'development') === 'production',
      path: '/',
      maxAge: ttlMinutes * 60,
    });
  }
}
