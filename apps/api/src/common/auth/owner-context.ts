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

  async validateRequest(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = request.cookies?.[OWNER_SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('Session manquante');

    const payload = await this.jwt.verify<SessionJwtPayload>(token);
    if (payload.purpose !== 'owner-session' || payload.role !== 'OWNER' || !payload.jti) {
      throw new UnauthorizedException('Session invalide');
    }

    const session = await this.prisma.ownerSession.findUnique({
      where: { id: payload.jti },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.user.role !== 'OWNER') {
      throw new UnauthorizedException('Session invalide ou révoquée');
    }

    const now = Date.now();

    // Plafond absolu : une session ne peut pas dépasser
    // OWNER_SESSION_ABSOLUTE_TTL_HOURS depuis sa création, même en activité
    // continue. Le jeton/cookie (durée absolue) ne limite jamais avant lui.
    const absoluteTtlHours = this.config.get<number>('OWNER_SESSION_ABSOLUTE_TTL_HOURS', 8);
    if (now - session.createdAt.getTime() > absoluteTtlHours * 3_600_000) {
      throw new UnauthorizedException('Session expirée');
    }

    // Fenêtre d'inactivité : sans requête pendant OWNER_SESSION_TTL_MINUTES, la
    // session est réputée expirée. expiresAt glisse à chaque activité détectée.
    const ttlMinutes = this.config.get<number>('OWNER_SESSION_TTL_MINUTES', 30);
    const ttlMs = ttlMinutes * 60_000;
    const idleExpiryMs = session.expiresAt.getTime();
    if (idleExpiryMs <= now) {
      throw new UnauthorizedException('Session expirée par inactivité');
    }

    if (idleExpiryMs - now < ttlMs / 2) {
      await this.prisma.ownerSession.update({
        where: { id: session.id },
        data: { expiresAt: new Date(now + ttlMs) },
      });
      session.expiresAt = new Date(now + ttlMs);
    }

    (request as FastifyRequest & { ownerContext?: OwnerContext }).ownerContext = {
      userId: session.userId,
      email: session.user.email,
      sessionId: session.id,
      expiresAt: session.expiresAt,
    };
  }
}
