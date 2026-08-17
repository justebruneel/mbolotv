import { createHash } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
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
export class OwnerAuthService implements OnModuleInit {
  private readonly logger = new Logger(OwnerAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
    private readonly rateLimiter: RateLimiterService,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Provisionne le compte propriétaire depuis l'environnement à chaque démarrage :
   * OWNER_EMAIL + OWNER_PASSWORD deviennent la seule source de vérité, ce qui rend
   * le script create-owner inutile et garantit que les identifiants du .env
   * fonctionnent toujours (le hash est réécrit au boot).
   */
  async onModuleInit(): Promise<void> {
    await this.bootstrapOwnerFromEnv();
  }

  private async bootstrapOwnerFromEnv(): Promise<void> {
    const email = (this.config.get<string>('OWNER_EMAIL') ?? '').trim().toLowerCase();
    const password = this.config.get<string>('OWNER_PASSWORD') ?? '';
    if (!email) {
      this.logger.warn('OWNER_EMAIL non défini : aucun compte propriétaire provisionné.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.logger.warn(`OWNER_EMAIL invalide (${email}) : provisionnement ignoré.`);
      return;
    }
    if (!password) {
      this.logger.warn(`OWNER_EMAIL défini mais OWNER_PASSWORD absent : connexion console impossible pour ${email}.`);
      return;
    }

    const passwordHash = await this.password.hashPassword(password);
    await this.prisma.user.upsert({
      where: { email },
      update: { role: 'OWNER', passwordHash },
      create: { email, role: 'OWNER', passwordHash },
    });
    this.logger.log(`Compte propriétaire prêt : ${email}`);
  }

  async login(
    input: OwnerLoginInput,
    ip: string,
    userAgent: string | undefined,
    reply: FastifyReply,
  ): Promise<OwnerMe> {
    const email = input.email.trim().toLowerCase();

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

    const idleTtlMinutes = this.config.get<number>('OWNER_SESSION_TTL_MINUTES', 30);
    const absoluteTtlHours = this.config.get<number>('OWNER_SESSION_ABSOLUTE_TTL_HOURS', 8);
    const now = Date.now();
    const session = await this.prisma.ownerSession.create({
      data: {
        userId: user.id,
        userAgent: userAgent?.slice(0, 200) ?? null,
        ipHash: this.shortHash(ip),
        // Fenêtre d'inactivité : glissée à chaque requête par OwnerGuard.
        expiresAt: new Date(now + idleTtlMinutes * 60_000),
      },
    });

    // Le jeton/cookie couvre la durée ABSOLUE : la déconnexion par inactivité est
    // gérée côté serveur via expiresAt (base), pas par le jeton (dont le
    // renouvellement ne pourrait pas atteindre le navigateur via middleware/RSC).
    const tokenTtlSeconds = Math.max(idleTtlMinutes * 60, absoluteTtlHours * 3_600);
    const token = await this.jwt.sign(
      {
        purpose: 'owner-session',
        sub: user.id,
        email: user.email,
        role: 'OWNER',
        jti: session.id,
      },
      tokenTtlSeconds,
    );
    this.setSessionCookie(reply, token, tokenTtlSeconds / 60);

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
