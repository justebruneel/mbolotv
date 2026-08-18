import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuditEntry, Overview } from '@mbolo/contracts';
import { getOwnerContext } from '../../common/auth/owner-context';
import { OwnerAuthGuard } from '../../common/auth/owner-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { z } from 'zod';

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

@UseGuards(OwnerAuthGuard)
@Controller('owner')
export class OwnerConsoleController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('overview')
  async overview(@Req() request: FastifyRequest): Promise<Overview> {
    const ownerId = getOwnerContext(request).userId;
    const [sources, channels, variants, activeImports, liveMatches, recentAudit] =
      await Promise.all([
        this.prisma.source.groupBy({
          by: ['status'],
          where: { ownerId },
          _count: { _all: true },
        }),
        this.prisma.channel.count({
          where: { variants: { some: { source: { ownerId } } } },
        }),
        this.prisma.streamVariant.count({ where: { source: { ownerId } } }),
        this.prisma.importRun.count({
          where: {
            state: { in: ['QUEUED', 'FETCHING', 'PARSING', 'NORMALIZING'] },
            source: { ownerId },
          },
        }),
        this.prisma.match.count({
          where: {
            state: 'LIVE',
            matchStreams: { some: { streamVariant: { source: { ownerId } } } },
          },
        }),
        this.prisma.auditLog.findMany({
          where: { actorId: ownerId },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
      ]);

    const sourcesByStatus: Record<string, number> = {};
    for (const group of sources) {
      sourcesByStatus[group.status] = group._count._all;
    }

    const alerts: Overview['alerts'] = [];
    const failed = sourcesByStatus['FAILED'] ?? 0;
    const degraded = sourcesByStatus['DEGRADED'] ?? 0;
    if (failed > 0) {
      alerts.push({ severity: 'critical', message: `${failed} source(s) en erreur` });
    }
    if (degraded > 0) {
      alerts.push({ severity: 'warning', message: `${degraded} source(s) dégradée(s)` });
    }
    if (activeImports > 0) {
      alerts.push({ severity: 'warning', message: `${activeImports} import(s) en cours` });
    }

    return {
      sourcesByStatus,
      channelCount: channels,
      variantCount: variants,
      activeImports,
      liveMatches,
      alerts,
      recentAudit: recentAudit.map((entry) => this.serializeAudit(entry)),
    };
  }

  @Get('audit')
  async audit(
    @Req() request: FastifyRequest,
    @Query(new ZodValidationPipe(auditQuerySchema)) query: { limit?: number; offset?: number },
  ): Promise<{ items: AuditEntry[]; total: number }> {
    const ownerId = getOwnerContext(request).userId;
    const where = { actorId: ownerId };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.limit ?? 50,
        skip: query.offset ?? 0,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items: items.map((entry) => this.serializeAudit(entry)), total };
  }

  private serializeAudit(entry: {
    id: string;
    action: string;
    entity: string;
    entityId: string | null;
    actorId: string | null;
    metadata: unknown;
    createdAt: Date;
  }): AuditEntry {
    return {
      id: entry.id,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      actorId: entry.actorId,
      metadata: (entry.metadata ?? null) as Record<string, unknown> | null,
      createdAt: entry.createdAt.toISOString(),
    };
  }
}
