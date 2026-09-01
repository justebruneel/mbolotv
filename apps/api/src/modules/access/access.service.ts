import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import type { AccessCode, AccessCodeCreateInput, AccessStatus } from '@mbolo/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';

type CodeRow = { id: string; codeLast4: string; kind: string; durationHours: number; active: boolean; createdAt: Date; revokedAt: Date | null; grant: { expiresAt: Date } | null };
const ACTIVE_GRANT_CACHE_TTL_MS = 15_000;
const INACTIVE_GRANT_CACHE_TTL_MS = 2_000;
const MAX_ACTIVE_GRANT_CACHE_ENTRIES = 10_000;

@Injectable()
export class AccessService {
  private readonly whatsappUrl: string;
  // Les segments HLS arrivent par dizaines. Vérifier le même droit en base pour
  // chacun sature rapidement la base et retarde le buffer du lecteur.
  private readonly activeGrantCache = new Map<string, { active: boolean; expiresAt: number }>();

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, config: ConfigService) {
    this.whatsappUrl = config.get<string>('PUBLIC_ACCESS_WHATSAPP_URL', 'https://wa.me/qr/CPB7IL3GHAGIK1');
  }

  async status(deviceId: string | undefined): Promise<AccessStatus> {
    const grant = await this.findGrant(deviceId);
    return {
      active: Boolean(grant),
      expiresAt: grant?.expiresAt.toISOString() ?? null,
      kind: grant?.accessCode.kind === 'PROMO' ? 'PROMO' : grant ? 'STANDARD' : null,
      whatsappUrl: await this.resolveWhatsappUrl(),
    };
  }

  async isGrantActive(deviceId: string | undefined): Promise<boolean> {
    if (!deviceId) return false;
    const deviceHash = this.hash(deviceId);
    const cached = this.activeGrantCache.get(deviceHash);
    if (cached && cached.expiresAt > Date.now()) return cached.active;
    const grant = await this.prisma.deviceGrant.findFirst({
      where: { deviceHash, expiresAt: { gt: new Date() }, accessCode: { active: true, revokedAt: null } },
      select: { id: true },
    });
    const active = Boolean(grant);
    this.cacheGrantStatus(deviceHash, active);
    return active;
  }

  private async resolveWhatsappUrl(): Promise<string> {
    const owner = await this.prisma.user.findFirst({ where: { role: 'OWNER', whatsappContact: { not: null } }, select: { whatsappContact: true } });
    if (!owner?.whatsappContact) return this.whatsappUrl;
    const contact = owner.whatsappContact.trim();
    if (/^https?:\/\//i.test(contact)) return contact;
    const digits = contact.replace(/[^\d]/g, '');
    if (digits.length >= 8) return `https://wa.me/${digits}`;
    return this.whatsappUrl;
  }

  async redeem(code: string, deviceId: string, userAgent: string | undefined, ip: string): Promise<AccessStatus> {
    const normalized = code.trim().toUpperCase();
    const codeHash = this.hash(normalized);
    const accessCode = await this.prisma.accessCode.findUnique({ where: { codeHash }, include: { grant: true } });
    if (!accessCode || !accessCode.active || accessCode.revokedAt) throw new ForbiddenException('Code invalide ou désactivé');
    const deviceHash = this.hash(deviceId);
    if (accessCode.grant) {
      if (accessCode.grant.deviceHash !== deviceHash) throw new ConflictException('Ce code est déjà lié à un autre appareil');
      if (accessCode.grant.expiresAt <= new Date()) throw new ForbiddenException('Ce code a expiré');
      await this.prisma.deviceGrant.update({ where: { id: accessCode.grant.id }, data: { lastSeenAt: new Date() } });
      this.activeGrantCache.delete(deviceHash);
      return this.status(deviceId);
    }

    // Prolongement : la durée du nouveau code s'ajoute à l'accès actif restant
    // (pas à maintenant), sinon un code plus court que le temps restant serait
    // perdu — le statut retenant l'expiration la plus lointaine.
    const currentGrant = await this.findGrant(deviceId);
    const baseTime = currentGrant ? Math.max(currentGrant.expiresAt.getTime(), Date.now()) : Date.now();
    const expiresAt = new Date(baseTime + accessCode.durationHours * 3_600_000);
    try {
      await this.prisma.deviceGrant.create({ data: { accessCodeId: accessCode.id, deviceHash, userAgent: userAgent?.slice(0, 200) ?? null, ipHash: this.hash(ip), expiresAt } });
    } catch {
      throw new ConflictException('Ce code vient d’être utilisé sur un autre appareil');
    }
    await this.audit.log(null, 'access.redeem', 'access_code', accessCode.id, { kind: accessCode.kind, expiresAt: expiresAt.toISOString() });
    this.activeGrantCache.delete(deviceHash);
    return this.status(deviceId);
  }

  async create(ownerId: string, input: AccessCodeCreateInput): Promise<AccessCode> {
    const kind = input.kind ?? 'STANDARD';
    const durationHours = kind === 'PROMO' ? 24 : (input.durationDays ?? 7) * 24;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rawCode = this.generateCode(kind);
      try {
        const row = await this.prisma.accessCode.create({ data: { codeHash: this.hash(rawCode), codeLast4: rawCode.slice(-4), kind, durationHours, createdById: ownerId } });
        await this.audit.log(ownerId, 'access_code.create', 'access_code', row.id, { kind, durationHours });
        return { id: row.id, code: rawCode, codeLast4: row.codeLast4, kind: kind as 'STANDARD' | 'PROMO', durationHours, active: row.active, createdAt: row.createdAt.toISOString(), expiresAt: null, deviceBound: false };
      } catch (error) {
        if (attempt === 4) throw error;
      }
    }
    throw new Error('Impossible de générer un code');
  }

  async list(ownerId: string): Promise<AccessCode[]> {
    const rows = await this.prisma.accessCode.findMany({ where: { createdById: ownerId }, include: { grant: true }, orderBy: { createdAt: 'desc' }, take: 200 }) as unknown as CodeRow[];
    return rows.map((row) => ({ id: row.id, code: null, codeLast4: row.codeLast4, kind: row.kind as 'STANDARD' | 'PROMO', durationHours: row.durationHours, active: row.active && !row.revokedAt, createdAt: row.createdAt.toISOString(), expiresAt: row.grant?.expiresAt.toISOString() ?? null, deviceBound: Boolean(row.grant) }));
  }

  async revoke(ownerId: string, id: string): Promise<void> {
    const row = await this.prisma.accessCode.findFirst({ where: { id, createdById: ownerId } });
    if (!row) throw new NotFoundException('Code introuvable');
    await this.prisma.accessCode.update({ where: { id }, data: { active: false, revokedAt: new Date() } });
    // Une révocation doit prendre effet sans attendre le TTL de 15 s.
    this.activeGrantCache.clear();
    await this.audit.log(ownerId, 'access_code.revoke', 'access_code', id, {});
  }

  private async findGrant(deviceId: string | undefined): Promise<{ expiresAt: Date; accessCode: { kind: string } } | null> {
    if (!deviceId) return null;
    const grant = await this.prisma.deviceGrant.findFirst({ where: { deviceHash: this.hash(deviceId), expiresAt: { gt: new Date() }, accessCode: { active: true, revokedAt: null } }, include: { accessCode: { select: { kind: true } } }, orderBy: { expiresAt: 'desc' } });
    if (grant) await this.prisma.deviceGrant.update({ where: { id: grant.id }, data: { lastSeenAt: new Date() } });
    return grant;
  }

  private generateCode(kind: 'STANDARD' | 'PROMO'): string {
    const prefix = kind === 'PROMO' ? 'PROMO' : 'MBLO';
    return `${prefix}-${randomBytes(5).toString('hex').toUpperCase()}`;
  }

  private hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

  private cacheGrantStatus(deviceHash: string, active: boolean): void {
    if (this.activeGrantCache.size >= MAX_ACTIVE_GRANT_CACHE_ENTRIES) {
      const now = Date.now();
      for (const [key, entry] of this.activeGrantCache) {
        if (entry.expiresAt <= now) this.activeGrantCache.delete(key);
      }
      if (this.activeGrantCache.size >= MAX_ACTIVE_GRANT_CACHE_ENTRIES) this.activeGrantCache.delete(this.activeGrantCache.keys().next().value!);
    }
    this.activeGrantCache.set(deviceHash, { active, expiresAt: Date.now() + (active ? ACTIVE_GRANT_CACHE_TTL_MS : INACTIVE_GRANT_CACHE_TTL_MS) });
  }
}
