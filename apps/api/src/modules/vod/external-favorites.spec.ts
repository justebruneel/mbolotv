import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@mbolo/db';
import { VodService } from './vod.service';

const p2002 = () => new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' });
const p2025 = () => new Prisma.PrismaClientKnownRequestError('absent', { code: 'P2025', clientVersion: 'test' });

function buildService() {
  const externalTitle = {
    findFirst: jest.fn(),
    findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({ id, title: `Titre ${id}`, year: 2024, posterUrl: null, kind: 'SERIES', sources: [] })),
    ),
  };
  const externalFavorite = {
    findMany: jest.fn(),
    create: jest.fn(async () => ({ ok: true })),
    delete: jest.fn(async () => ({ ok: true })),
  };
  const prisma = { externalTitle, externalFavorite };
  const service = new VodService(prisma as never, {} as never, {} as never);
  return { service, prisma };
}

describe('vod.service external favorites', () => {
  describe('listExternalFavorites', () => {
    it('exige x-device-id', async () => {
      const { service } = buildService();
      await expect(service.listExternalFavorites(undefined)).rejects.toThrow(BadRequestException);
    });

    it('renvoie une liste vide sans interroger les titres quand aucun favori', async () => {
      const { service, prisma } = buildService();
      prisma.externalFavorite.findMany.mockResolvedValueOnce([]);
      await expect(service.listExternalFavorites('dev-1')).resolves.toEqual({ items: [] });
      expect(prisma.externalTitle.findMany).not.toHaveBeenCalled();
    });

    it('classe les favoris du plus récent au plus ancien et sérialise les titres', async () => {
      const { service, prisma } = buildService();
      // findMany trie par createdAt desc : 'recent' est le favori le plus récent.
      prisma.externalFavorite.findMany.mockResolvedValueOnce([{ externalTitleId: 'recent' }, { externalTitleId: 'old' }]);
      await expect(service.listExternalFavorites('dev-1')).resolves.toEqual({
        items: [
          { id: 'recent', title: 'Titre recent', year: 2024, posterUrl: null, kind: 'SERIES', healthySources: 0 },
          { id: 'old', title: 'Titre old', year: 2024, posterUrl: null, kind: 'SERIES', healthySources: 0 },
        ],
      });
      expect(prisma.externalTitle.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['recent', 'old'] }, isVisible: true }) }));
    });
  });

  describe('addExternalFavorite', () => {
    it('exige x-device-id', async () => {
      const { service } = buildService();
      await expect(service.addExternalFavorite(undefined, 'title-1')).rejects.toThrow(BadRequestException);
    });

    it('refuse un titre inconnu ou masqué (404)', async () => {
      const { service, prisma } = buildService();
      prisma.externalTitle.findFirst.mockResolvedValueOnce(null);
      await expect(service.addExternalFavorite('dev-1', 'title-1')).rejects.toThrow(NotFoundException);
      expect(prisma.externalTitle.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'title-1', isVisible: true } }));
      expect(prisma.externalFavorite.create).not.toHaveBeenCalled();
    });

    it('est idempotent à la seconde création (P2002)', async () => {
      const { service, prisma } = buildService();
      prisma.externalTitle.findFirst.mockResolvedValueOnce({ id: 'title-1' });
      prisma.externalFavorite.create.mockRejectedValueOnce(p2002());
      await expect(service.addExternalFavorite('dev-1', 'title-1')).resolves.toEqual({ ok: true });
    });

    it('remonte les erreurs autres que P2002', async () => {
      const { service, prisma } = buildService();
      prisma.externalTitle.findFirst.mockResolvedValueOnce({ id: 'title-1' });
      prisma.externalFavorite.create.mockRejectedValueOnce(new Error('boom'));
      await expect(service.addExternalFavorite('dev-1', 'title-1')).rejects.toThrow('boom');
    });
  });

  describe('removeExternalFavorite', () => {
    it('exige x-device-id', async () => {
      const { service } = buildService();
      await expect(service.removeExternalFavorite(undefined, 'title-1')).rejects.toThrow(BadRequestException);
    });

    it('est idempotent quand le favori est absent (P2025)', async () => {
      const { service, prisma } = buildService();
      prisma.externalFavorite.delete.mockRejectedValueOnce(p2025());
      await expect(service.removeExternalFavorite('dev-1', 'title-1')).resolves.toEqual({ ok: true });
    });

    it('supprime la paire device + titre', async () => {
      const { service, prisma } = buildService();
      await service.removeExternalFavorite('dev-1', 'title-1');
      expect(prisma.externalFavorite.delete).toHaveBeenCalledWith({ where: { deviceId_externalTitleId: { deviceId: 'dev-1', externalTitleId: 'title-1' } } });
    });
  });
});