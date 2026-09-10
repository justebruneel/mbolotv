import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@mbolo/db';
import { VodService } from './vod.service';

const p2002 = () => new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' });
const p2025 = () => new Prisma.PrismaClientKnownRequestError('absent', { code: 'P2025', clientVersion: 'test' });

function buildService() {
  const vodItem = {
    findFirst: jest.fn(),
    findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, kind: 'MOVIE', title: `Titre ${id}`, posterUrl: null, rating: null, categoryTitle: null, addedAt: null }))),
  };
  const vodFavorite = {
    findMany: jest.fn(),
    create: jest.fn(async () => ({ ok: true })),
    delete: jest.fn(async () => ({ ok: true })),
  };
  const prisma = { vodItem, vodFavorite };
  const service = new VodService(prisma as never, {} as never, {} as never);
  return { service, prisma };
}

describe('vod.service favorites', () => {
  describe('listFavorites', () => {
    it('exige x-device-id', async () => {
      const { service } = buildService();
      await expect(service.listFavorites(undefined)).rejects.toThrow(BadRequestException);
    });

    it('renvoie une liste vide sans interroger les items quand aucun favori', async () => {
      const { service, prisma } = buildService();
      prisma.vodFavorite.findMany.mockResolvedValueOnce([]);
      await expect(service.listFavorites('dev-1')).resolves.toEqual({ items: [] });
      expect(prisma.vodItem.findMany).not.toHaveBeenCalled();
    });

    it('classe les favoris du plus récent au plus ancien et sérialise les items', async () => {
      const { service, prisma } = buildService();
      // findMany trie par createdAt desc : 'recent' est le favori le plus récent.
      prisma.vodFavorite.findMany.mockResolvedValueOnce([{ vodItemId: 'recent' }, { vodItemId: 'old' }]);
      await expect(service.listFavorites('dev-1')).resolves.toEqual({
        items: [
          { id: 'recent', kind: 'MOVIE', title: 'Titre recent', posterUrl: null, rating: null, category: null, addedAt: null },
          { id: 'old', kind: 'MOVIE', title: 'Titre old', posterUrl: null, rating: null, category: null, addedAt: null },
        ],
      });
      expect(prisma.vodItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['recent', 'old'] }, isActive: true, isVisible: true }) }));
    });
  });

  describe('addFavorite', () => {
    it('exige x-device-id', async () => {
      const { service } = buildService();
      await expect(service.addFavorite(undefined, 'item-1')).rejects.toThrow(BadRequestException);
    });

    it('refuse un item inconnu ou masqué (404)', async () => {
      const { service, prisma } = buildService();
      prisma.vodItem.findFirst.mockResolvedValueOnce(null);
      await expect(service.addFavorite('dev-1', 'item-1')).rejects.toThrow(NotFoundException);
      expect(prisma.vodItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'item-1', isActive: true, isVisible: true } }));
      expect(prisma.vodFavorite.create).not.toHaveBeenCalled();
    });

    it('est idempotent à la seconde création (P2002)', async () => {
      const { service, prisma } = buildService();
      prisma.vodItem.findFirst.mockResolvedValueOnce({ id: 'item-1' });
      prisma.vodFavorite.create.mockRejectedValueOnce(p2002());
      await expect(service.addFavorite('dev-1', 'item-1')).resolves.toEqual({ ok: true });
    });

    it('remonte les erreurs autres que P2002', async () => {
      const { service, prisma } = buildService();
      prisma.vodItem.findFirst.mockResolvedValueOnce({ id: 'item-1' });
      prisma.vodFavorite.create.mockRejectedValueOnce(new Error('boom'));
      await expect(service.addFavorite('dev-1', 'item-1')).rejects.toThrow('boom');
    });
  });

  describe('removeFavorite', () => {
    it('exige x-device-id', async () => {
      const { service } = buildService();
      await expect(service.removeFavorite(undefined, 'item-1')).rejects.toThrow(BadRequestException);
    });

    it('est idempotent quand le favori est absent (P2025)', async () => {
      const { service, prisma } = buildService();
      prisma.vodFavorite.delete.mockRejectedValueOnce(p2025());
      await expect(service.removeFavorite('dev-1', 'item-1')).resolves.toEqual({ ok: true });
    });

    it('supprime la paire device + item', async () => {
      const { service, prisma } = buildService();
      await service.removeFavorite('dev-1', 'item-1');
      expect(prisma.vodFavorite.delete).toHaveBeenCalledWith({ where: { deviceId_vodItemId: { deviceId: 'dev-1', vodItemId: 'item-1' } } });
    });
  });
});