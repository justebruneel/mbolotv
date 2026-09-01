import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { AccessService } from './access.service';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function buildService() {
  const prisma = {
    accessCode: { findUnique: jest.fn() },
    deviceGrant: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn().mockResolvedValue(undefined), create: jest.fn().mockResolvedValue(undefined) },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const config = { get: (_key: string, fallback: string) => fallback } as unknown as ConfigService;
  const service = new AccessService(prisma as never, audit as never, config);
  return { service, prisma, audit };
}

describe('AccessService.redeem — prolongement', () => {
  const baseCode = (overrides: Record<string, unknown> = {}) => ({ id: 'code-2', active: true, revokedAt: null, kind: 'STANDARD', durationHours: 7 * 24, grant: null, ...overrides });

  it('empile la durée sur l\u2019accès restant (20 j restants + code 7 j → 27 j)', async () => {
    const { service, prisma } = buildService();
    const existingExpiry = new Date(Date.now() + 20 * DAY_MS);
    prisma.accessCode.findUnique.mockResolvedValue(baseCode());
    prisma.deviceGrant.findFirst.mockResolvedValue({ expiresAt: existingExpiry, accessCode: { kind: 'STANDARD' } });

    await service.redeem('MBLO-ABCDEF1234', 'device-1', 'ua', '1.2.3.4');

    expect(prisma.deviceGrant.create).toHaveBeenCalledTimes(1);
    const expiresAt = prisma.deviceGrant.create.mock.calls[0][0].data.expiresAt as Date;
    const expected = existingExpiry.getTime() + 7 * DAY_MS;
    expect(Math.abs(expiresAt.getTime() - expected)).toBeLessThan(60_000);
  });

  it('empile aussi un code plus court que le temps restant (20 j restants + PROMO 24 h → 21 j)', async () => {
    const { service, prisma } = buildService();
    const existingExpiry = new Date(Date.now() + 20 * DAY_MS);
    prisma.accessCode.findUnique.mockResolvedValue(baseCode({ kind: 'PROMO', durationHours: 24 }));
    prisma.deviceGrant.findFirst.mockResolvedValue({ expiresAt: existingExpiry, accessCode: { kind: 'PROMO' } });

    await service.redeem('PROMO-ABCDEF1234', 'device-1', 'ua', '1.2.3.4');

    const expiresAt = prisma.deviceGrant.create.mock.calls[0][0].data.expiresAt as Date;
    const expected = existingExpiry.getTime() + 24 * HOUR_MS;
    expect(Math.abs(expiresAt.getTime() - expected)).toBeLessThan(60_000);
  });

  it('part de maintenant quand aucun accès actif (partie de zéro)', async () => {
    const { service, prisma } = buildService();
    prisma.accessCode.findUnique.mockResolvedValue(baseCode());
    prisma.deviceGrant.findFirst.mockResolvedValue(null);
    const before = Date.now();

    await service.redeem('MBLO-ABCDEF1234', 'device-1', 'ua', '1.2.3.4');

    const expiresAt = prisma.deviceGrant.create.mock.calls[0][0].data.expiresAt as Date;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
    expect(expiresAt.getTime()).toBeLessThan(Date.now() + 7 * DAY_MS + 60_000);
  });

  it('ne prolonge pas avec le même code déjà lié (simple rafraîchissement)', async () => {
    const { service, prisma } = buildService();
    prisma.accessCode.findUnique.mockResolvedValue(baseCode({ id: 'code-1', grant: { id: 'g1', deviceHash: hash('device-1'), expiresAt: new Date(Date.now() + 5 * DAY_MS) } }));

    await service.redeem('MBLO-ABCDEF1234', 'device-1', 'ua', '1.2.3.4');

    expect(prisma.deviceGrant.create).not.toHaveBeenCalled();
    expect(prisma.deviceGrant.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'g1' } }));
  });

  it('refuse un code déjà lié à un autre appareil', async () => {
    const { service, prisma } = buildService();
    prisma.accessCode.findUnique.mockResolvedValue(baseCode({ grant: { id: 'g1', deviceHash: hash('other-device'), expiresAt: new Date(Date.now() + 5 * DAY_MS) } }));

    await expect(service.redeem('MBLO-ABCDEF1234', 'device-1', 'ua', '1.2.3.4')).rejects.toThrow(ConflictException);
  });

  it('refuse le même code si son accès a expiré', async () => {
    const { service, prisma } = buildService();
    prisma.accessCode.findUnique.mockResolvedValue(baseCode({ grant: { id: 'g1', deviceHash: hash('device-1'), expiresAt: new Date(Date.now() - HOUR_MS) } }));

    await expect(service.redeem('MBLO-ABCDEF1234', 'device-1', 'ua', '1.2.3.4')).rejects.toThrow(ForbiddenException);
  });
});
