import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

export const OWNER_SESSION_COOKIE = 'mbolo_owner_session';

export interface OwnerContext {
  userId: string;
  email: string;
  sessionId: string;
  mfaVerifiedAt: Date;
  expiresAt: Date;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

export function getOwnerContext(request: FastifyRequest): OwnerContext {
  return (request as FastifyRequest & { ownerContext?: OwnerContext }).ownerContext!;
}

@Injectable()
export class OwnerGuard {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  async validateRequest(request: FastifyRequest): Promise<void> {
    const token = parseCookies(request.headers.cookie)[OWNER_SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('Session manquante');

    const session = await this.prisma.ownerSession.findUnique({
      where: { tokenHash: this.crypto.hashToken(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Session invalide ou expirée');
    }

    const absoluteTtlHours = this.config.get<number>('OWNER_SESSION_ABSOLUTE_TTL_HOURS', 8);
    const absoluteMs = absoluteTtlHours * 3_600_000;
    if (Date.now() - session.createdAt.getTime() > absoluteMs) {
      await this.prisma.ownerSession.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Session expirée');
    }

    if (session.user.role !== 'OWNER') {
      throw new ForbiddenException('Accès réservé au propriétaire');
    }

    const ttlMinutes = this.config.get<number>('OWNER_SESSION_TTL_MINUTES', 15);
    await this.prisma.ownerSession.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() + ttlMinutes * 60_000) },
    });

    (request as FastifyRequest & { ownerContext?: OwnerContext }).ownerContext = {
      userId: session.userId,
      email: session.user.email,
      sessionId: session.id,
      mfaVerifiedAt: session.mfaVerifiedAt,
      expiresAt: session.expiresAt,
    };
  }
}