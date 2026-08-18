import { ConflictException } from '@nestjs/common';
import { SourcesService } from './sources.service';

const CHUNK = 10_000;

function buildService(orphanIds: string[], activeImport = false) {
  const deleteManyCalls: { ids: string[]; count: number }[] = [];
  const prisma = {
    source: { findFirst: jest.fn(async () => ({ id: 'source-1', name: 'Playlist test' })), delete: jest.fn(async () => ({})) },
    importRun: { findFirst: jest.fn(async () => activeImport ? { id: 'run-1' } : null) },
    channel: {
      findMany: jest.fn(async () => orphanIds.map((id) => ({ id }))),
      deleteMany: jest.fn(async (args: { where: { id: { in: string[] } } }) => { deleteManyCalls.push({ ids: args.where.id.in, count: args.where.id.in.length }); return { count: args.where.id.in.length }; }),
    },
  };
  const audit = { log: jest.fn(async () => undefined) };
  const storage = { put: jest.fn(async () => undefined), get: jest.fn(async () => null) };
  const config = { get: jest.fn((_key: string, fallback: unknown) => fallback) };
  const service = new SourcesService(prisma as never, {} as never, audit as never, {} as never, storage as never, config as never);
  return { service, deleteManyCalls, audit, prisma };
}

describe('sources.service.remove', () => {
  it('supprime les orphelins par lots de 10 000', async () => {
    const orphanIds = Array.from({ length: 401_445 }, (_, i) => `ch-${i}`);
    const { service, deleteManyCalls, audit } = buildService(orphanIds);
    await service.remove('owner-1', 'source-1');
    expect(deleteManyCalls.length).toBe(Math.ceil(orphanIds.length / CHUNK));
    expect(deleteManyCalls.reduce((sum, call) => sum + call.count, 0)).toBe(orphanIds.length);
    expect(audit.log).toHaveBeenCalledWith('owner-1', 'source.delete', 'source', 'source-1', { name: 'Playlist test', orphanChannelsRemoved: orphanIds.length });
  });

  it('refuse la suppression pendant un import actif', async () => {
    const { service, deleteManyCalls, prisma } = buildService([], true);
    await expect(service.remove('owner-1', 'source-1')).rejects.toThrow(ConflictException);
    expect(prisma.source.delete).not.toHaveBeenCalled();
    expect(deleteManyCalls).toHaveLength(0);
  });

  it('ne fait aucun appel deleteMany quand il n’y a pas d’orphelins', async () => {
    const { service, deleteManyCalls, audit } = buildService([]);
    await service.remove('owner-1', 'source-1');
    expect(deleteManyCalls).toHaveLength(0);
    expect(audit.log).toHaveBeenCalledWith('owner-1', 'source.delete', 'source', 'source-1', expect.objectContaining({ orphanChannelsRemoved: 0 }));
  });
});
