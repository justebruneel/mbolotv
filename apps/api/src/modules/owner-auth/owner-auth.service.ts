import { createHash } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OwnerLoginInput, OwnerMe, OwnerSession } from '@mbolo/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { OWNER_SESSION_COOKIE } from '../../common/auth/owner-context';
import { JwtService } from '../../common/jwt/jwt.service';
import { PasswordService } from '../../common/password/password.service';
import { RateLimiterService } from '../../common/rate-limit/rate-limiter.service';
import { PrismaService } from '../../common/prisma/prisma.service';

interface SessionTokenPayload {
  purpose: 'owner-session';
  sub: string;
  email: string;
  role: 'OWNER';
  jti: string;
  iat?: number;
}

@Injectable()
export class OwnerAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
    private readonly rateLimiter: RateLimiterService,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(
    input: OwnerLoginInput,
    ip: string,
    userAgent: string | undefined,
    reply: FastifyReply,
  ): Promise<OwnerMe> {
    const email = input.email.toLowerCase();

    const byAccount = this.rateLimiter.check(
      `owner-login:${email}`,
      this.config.get<number>('OWNER_LOGIN_MAX_ATTEMPTS', 5),
      15 * 60_000,
    );
    const byIp = this.rateLimiter.check(
      `owner-login-ip:${ip}`,
      this.config.get<number>('OWNER_LOGIN_MAX_PER_IP', 20),
      3_600_000,
    );
    if (!byAccount.allowed) {
      throw new HttpException(`Trop de tentatives, réessayez dans ${byAccount.retryAfterSeconds}s`, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (!byIp.allowed) {
      throw new HttpException('Trop de tentatives depuis cette adresse', HttpStatus.TOO_MANY_REQUESTS);
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.role !== 'OWNER' || !user.passwordHash) {
      throw new UnauthorizedException('Identifiants invalides');
    }
    const valid = await this.password.verifyPassword(user.passwordHash, input.password);
    if (!valid) {
      throw new UnauthorizedException('Identifiants invalides');
    }

    const ttlMinutes = this.config.get<number>('OWNER_SESSION_TTL_MINUTES', 15);
    const now = Date.now();
    const session = await this.prisma.ownerSession.create({
      data: {
        userId: user.id,
        userAgent: userAgent?.slice(0, 200) ?? null,
        ipHash: this.shortHash(ip),
        expiresAt: new Date(now + ttlMinutes * 60_000),
      },
    });

    const token = await this.jwt.sign(
      {
        purpose: 'owner-session',
        sub: user.id,
        email: user.email,
        role: 'OWNER',
        jti: session.id,
      },
      ttlMinutes * 60,
    );
    this.setSessionCookie(reply, token, ttlMinutes);

    await this.audit.log(user.id, 'owner.login', 'owner', user.id, {
      sessionId: session.id,
      ipHash: this.shortHash(ip),
    });

    return { id: user.id, email: user.email, role: user.role };
  }

  async logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies?.[OWNER_SESSION_COOKIE];
    if (token) {
      try {
        const payload = await this.jwt.verify<SessionTokenPayload>(token);
        if (payload.purpose === 'owner-session' && payload.jti) {
          const session = await this.prisma.ownerSession.findUnique({
            where: { id: payload.jti },
          });
          if (session && !session.revokedAt) {
            await this.prisma.ownerSession.update({
              where: { id: session.id },
              data: { revokedAt: new Date() },
            });
            await this.audit.log(session.userId, 'owner.logout', 'owner', session.userId, {
              sessionId: session.id,
            });
          }
        }
      } catch {
        // Jeton illisible : on nettoie simplement le cookie de session.
      }
    }
    reply.clearCookie(OWNER_SESSION_COOKIE, { path: '/' });
  }

  async currentSession(
    request: FastifyRequest,
  ): Promise<{ me: OwnerMe; sessionId: string; expiresAt: Date }> {
    const token = request.cookies?.[OWNER_SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('Session manquante');

    const payload = await this.jwt.verify<SessionTokenPayload>(token);
    if (payload.purpose !== 'owner-session' || !payload.jti) {
      throw new UnauthorizedException('Session invalide');
    }

    const session = await this.prisma.ownerSession.findUnique({
      where: { id: payload.jti },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.user.role !== 'OWNER') {
      throw new UnauthorizedException('Session invalide');
    }

    return {
      me: { id: session.userId, email: session.user.email, role: session.user.role },
      sessionId: session.id,
      expiresAt: session.expiresAt,
    };
  }

  async listSessions(userId: string, currentSessionId: string): Promise<OwnerSession[]> {
    const sessions = await this.prisma.ownerSession.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return sessions.map((session) => ({
      id: session.id,
      userAgent: session.userAgent,
      ipHash: session.ipHash,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      current: session.id === currentSessionId,
    }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.ownerSession.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) throw new NotFoundException('Session introuvable');
    await this.prisma.ownerSession.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
    await this.audit.log(userId, 'owner.session_revoke', 'owner', userId, { sessionId });
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

  private shortHash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }
}
