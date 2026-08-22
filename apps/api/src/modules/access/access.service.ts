import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import type { AccessCode, AccessCodeCreateInput, AccessStatus } from '@mbolo/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';

type CodeRow = { id: string; codeLast4: string; kind: string; durationHours: number; active: boolean; createdAt: Date; revokedAt: Date | null; grant: { expiresAt: Date } | null };

@Injectable()
export class AccessService {
  private readonly whatsappUrl: string;

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
    const grant = await this.prisma.deviceGrant.findFirst({
      where: { deviceHash: this.hash(deviceId), expiresAt: { gt: new Date() }, accessCode: { active: true, revokedAt: null } },
      select: { id: true },
    });
    return Boolean(grant);
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
      return this.status(deviceId);
    }

    const expiresAt = new Date(Date.now() + accessCode.durationHours * 3_600_000);
    try {
      await this.prisma.deviceGrant.create({ data: { accessCodeId: accessCode.id, deviceHash, userAgent: userAgent?.slice(0, 200) ?? null, ipHash: this.hash(ip), expiresAt } });
    } catch {
      throw new ConflictException('Ce code vient d’être utilisé sur un autre appareil');
    }
    await this.audit.log(null, 'access.redeem', 'access_code', accessCode.id, { kind: accessCode.kind, expiresAt: expiresAt.toISOString() });
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
}
