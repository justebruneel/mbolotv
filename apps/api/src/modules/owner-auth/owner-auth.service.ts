import { createHash } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OwnerLoginInput, OwnerMe, OwnerMfaVerifyInput, OwnerSession } from '@mbolo/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { OWNER_SESSION_COOKIE, parseCookies } from '../../common/auth/owner-context';
import { PasswordService } from '../../common/password/password.service';
import { RateLimiterService } from '../../common/rate-limit/rate-limiter.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TotpService } from '../../common/totp/totp.service';
import { ChallengeService } from './challenge.service';

@Injectable()
export class OwnerAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly password: PasswordService,
    private readonly totp: TotpService,
    private readonly rateLimiter: RateLimiterService,
    private readonly audit: AuditService,
    private readonly challenge: ChallengeService,
    private readonly config: ConfigService,
  ) {}

  async login(
    input: OwnerLoginInput,
    ip: string,
    _userAgent: string | undefined,
  ): Promise<{ challengeToken: string }> {
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
    if (!user.mfaEnabled || !user.mfaSecretEncrypted) {
      throw new ForbiddenException('MFA non configurée pour ce compte');
    }

    await this.audit.log(user.id, 'owner.login', 'owner', user.id, { ipHash: this.shortHash(ip) });

    const challengeToken = this.challenge.sign({
      sub: user.id,
      purpose: 'owner-mfa',
      exp: Math.floor(Date.now() / 1000) + 15 * 60,
    });
    return { challengeToken };
  }

  async mfaVerify(
    input: OwnerMfaVerifyInput,
    ip: string,
    userAgent: string | undefined,
    reply: FastifyReply,
  ): Promise<OwnerMe> {
    const challenge = this.challenge.verify(input.challengeToken);
    if (challenge.purpose !== 'owner-mfa') {
      throw new UnauthorizedException('Challenge invalide');
    }

    const user = await this.prisma.user.findUnique({ where: { id: challenge.sub } });
    if (!user || !user.mfaSecretEncrypted) throw new UnauthorizedException('Identifiants invalides');

    const byIp = this.rateLimiter.check(`owner-mfa-ip:${ip}`, 10, 15 * 60_000);
    if (!byIp.allowed) throw new HttpException('Trop de tentatives', HttpStatus.TOO_MANY_REQUESTS);

    const secret = this.crypto.decrypt(user.mfaSecretEncrypted);
    if (!this.totp.verify(secret, input.totpCode)) {
      throw new UnauthorizedException('Code TOTP invalide');
    }

    const token = this.crypto.randomToken(48);
    const ttlMinutes = this.config.get<number>('OWNER_SESSION_TTL_MINUTES', 15);
    const session = await this.prisma.ownerSession.create({
      data: {
        userId: user.id,
        tokenHash: this.crypto.hashToken(token),
        userAgent: userAgent?.slice(0, 200) ?? null,
        ipHash: this.shortHash(ip),
        mfaVerifiedAt: new Date(),
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
      },
    });

    reply.setCookie(OWNER_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.get<string>('NODE_ENV', 'development') === 'production',
      path: '/',
      maxAge: ttlMinutes * 60,
    });

    await this.audit.log(user.id, 'owner.mfa_verify', 'owner', user.id, {
      sessionId: session.id,
      ipHash: this.shortHash(ip),
    });

    return { id: user.id, email: user.email, role: user.role };
  }

  async logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = parseCookies(request.headers.cookie)[OWNER_SESSION_COOKIE];
    if (token) {
      const session = await this.prisma.ownerSession.findUnique({
        where: { tokenHash: this.crypto.hashToken(token) },
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
    reply.clearCookie(OWNER_SESSION_COOKIE, { path: '/' });
  }

  async reauthenticate(totpCode: string, request: FastifyRequest, ip: string): Promise<void> {
    const token = parseCookies(request.headers.cookie)[OWNER_SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('Session manquante');
    const session = await this.prisma.ownerSession.findUnique({
      where: { tokenHash: this.crypto.hashToken(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt || !session.user.mfaSecretEncrypted) {
      throw new UnauthorizedException('Session invalide');
    }

    const byIp = this.rateLimiter.check(`owner-reauth-ip:${ip}`, 10, 15 * 60_000);
    if (!byIp.allowed) throw new HttpException('Trop de tentatives', HttpStatus.TOO_MANY_REQUESTS);

    const secret = this.crypto.decrypt(session.user.mfaSecretEncrypted);
    if (!this.totp.verify(secret, totpCode)) {
      throw new UnauthorizedException('Code TOTP invalide');
    }

    await this.prisma.ownerSession.update({
      where: { id: session.id },
      data: { mfaVerifiedAt: new Date() },
    });
    await this.audit.log(session.userId, 'owner.reauthenticate', 'owner', session.userId, {
      sessionId: session.id,
    });
  }

  async currentSession(request: FastifyRequest): Promise<{ me: OwnerMe; sessionId: string }> {
    const token = parseCookies(request.headers.cookie)[OWNER_SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('Session manquante');
    const session = await this.prisma.ownerSession.findUnique({
      where: { tokenHash: this.crypto.hashToken(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Session invalide');
    }
    return {
      me: { id: session.userId, email: session.user.email, role: session.user.role },
      sessionId: session.id,
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

  private shortHash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }
}