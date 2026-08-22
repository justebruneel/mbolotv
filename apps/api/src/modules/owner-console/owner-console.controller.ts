import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuditEntry, ChannelTestResponse, OwnerCatalog, OwnerCategory, OwnerCategoryCreateInput, OwnerCategoryUpdateInput, OwnerChannel, OwnerChannelUpdateInput, OwnerProfile, OwnerProfileUpdateInput, Overview } from '@mbolo/contracts';
import { ownerCategoryCreateSchema, ownerCategoryUpdateSchema, ownerChannelUpdateSchema, ownerProfileUpdateSchema } from '@mbolo/contracts';
import { getOwnerContext } from '../../common/auth/owner-context';
import { OwnerAuthGuard } from '../../common/auth/owner-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuditService } from '../../common/audit/audit.service';
import { HealthCheckService } from '../channel-health/channel-health.service';
import { slugify } from '../../common/normalize/slugify';
import { z } from 'zod';

const auditQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() });
type StatusGroup = { status: string; _count: { _all: number } };
type AuditRow = { id: string; action: string; entity: string; entityId: string | null; actorId: string | null; metadata: unknown; createdAt: Date };
type OwnerVariant = { healthStatus: string | null };
type OwnerChannelRow = { id: string; name: string; canonicalName: string; categoryId: string | null; isVisible: boolean; variants: OwnerVariant[]; _count: { variants: number } };
type OwnerCategoryRow = { id: string; slug: string; name: string; parentId: string | null; isVisible: boolean; sortOrder: number; channels: OwnerChannelRow[] };

@UseGuards(OwnerAuthGuard)
@Controller('owner')
export class OwnerConsoleController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly health: HealthCheckService) {}

  @Get('overview')
  async overview(@Req() request: FastifyRequest): Promise<Overview> {
    const ownerId = getOwnerContext(request).userId;
    const [sources, channels, variants, activeImports, liveMatches, recentAudit] = await Promise.all([
      this.prisma.source.groupBy({ by: ['status'], where: { ownerId }, _count: { _all: true } }) as unknown as Promise<StatusGroup[]>,
      this.prisma.channel.count({ where: { variants: { some: { source: { ownerId } } } } }) as unknown as Promise<number>,
      this.prisma.streamVariant.count({ where: { source: { ownerId } } }) as unknown as Promise<number>,
      this.prisma.importRun.count({ where: { state: { in: ['QUEUED', 'FETCHING', 'PARSING', 'NORMALIZING'] }, source: { ownerId } } }) as unknown as Promise<number>,
      this.prisma.match.count({ where: { state: 'LIVE', matchStreams: { some: { streamVariant: { source: { ownerId } } } } } }) as unknown as Promise<number>,
      this.prisma.auditLog.findMany({ where: { actorId: ownerId }, orderBy: { createdAt: 'desc' }, take: 10 }) as unknown as Promise<AuditRow[]>,
    ]);
    const sourcesByStatus: Record<string, number> = {};
    for (const group of sources) sourcesByStatus[group.status] = Number(group._count._all ?? 0);
    const alerts: Overview['alerts'] = []; const failed = sourcesByStatus['FAILED'] ?? 0; const degraded = sourcesByStatus['DEGRADED'] ?? 0;
    if (failed > 0) alerts.push({ severity: 'critical', message: `${failed} source(s) en erreur` }); if (degraded > 0) alerts.push({ severity: 'warning', message: `${degraded} source(s) dégradée(s)` }); if (activeImports > 0) alerts.push({ severity: 'warning', message: `${activeImports} import(s) en cours` });
    return { sourcesByStatus, channelCount: channels, variantCount: variants, activeImports, liveMatches, alerts, recentAudit: recentAudit.map((entry: AuditRow) => this.serializeAudit(entry)) };
  }

  @Get('catalog')
  async catalog(@Req() request: FastifyRequest): Promise<OwnerCatalog> {
    const ownerId = getOwnerContext(request).userId;
    const channelScope = { variants: { some: { source: { ownerId } } } } as const;
    const [categories, channels] = await Promise.all([
      this.prisma.category.findMany({
        where: { channels: { some: channelScope } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, slug: true, name: true, parentId: true, isVisible: true, sortOrder: true },
      }) as unknown as OwnerCategoryRow[],
      this.prisma.channel.findMany({
        where: channelScope,
        orderBy: [{ sortOrder: 'asc' }, { canonicalName: 'asc' }],
        include: { variants: { where: { source: { ownerId } }, select: { healthStatus: true } }, _count: { select: { variants: true } } },
      }) as unknown as OwnerChannelRow[],
    ]);
    const channelsByCategory = new Map<string | null, OwnerChannelRow[]>();
    for (const channel of channels) { const bucket = channelsByCategory.get(channel.categoryId) ?? []; bucket.push(channel); channelsByCategory.set(channel.categoryId, bucket); }

    const byId = new Map(categories.map((category) => [category.id, category] as const));
    const effective = new Map<string, boolean>();
    const visiting = new Set<string>();
    const computeEffective = (id: string): boolean => {
      const cached = effective.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) { effective.set(id, false); return false; }
      visiting.add(id);
      const node = byId.get(id);
      if (!node) { visiting.delete(id); return false; }
      const parentOk = node.parentId == null || !byId.has(node.parentId) ? true : computeEffective(node.parentId);
      const result = node.isVisible && parentOk;
      visiting.delete(id);
      effective.set(id, result);
      return result;
    };
    categories.forEach((category) => computeEffective(category.id));
    const childrenByParent = new Map<string | null, OwnerCategoryRow[]>();
    for (const category of categories) { const bucket = childrenByParent.get(category.parentId) ?? []; bucket.push(category); childrenByParent.set(category.parentId, bucket); }
    const roots = categories.filter((category) => category.parentId == null || !byId.has(category.parentId));

    const visitingNodes = new Set<string>();
    const serializeNode = (node: OwnerCategoryRow): OwnerCategory => {
      if (visitingNodes.has(node.id)) return { id: node.id, slug: node.slug, name: node.name, parentId: node.parentId, isVisible: node.isVisible, effectiveVisible: effective.get(node.id) ?? node.isVisible, channelCount: 0, channels: [], children: [] };
      visitingNodes.add(node.id);
      const children = (childrenByParent.get(node.id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)).map((child) => serializeNode(child));
      visitingNodes.delete(node.id);
      const nodeChannels = channelsByCategory.get(node.id) ?? [];
      return {
        id: node.id,
        slug: node.slug,
        name: node.name,
        parentId: node.parentId,
        isVisible: node.isVisible,
        effectiveVisible: effective.get(node.id) ?? node.isVisible,
        channelCount: nodeChannels.length,
        channels: nodeChannels.map((channel) => this.serializeChannel(channel)),
        children,
      };
    };

    return {
      categories: roots.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)).map((node) => serializeNode(node)),
      uncategorized: (channelsByCategory.get(null) ?? []).map((channel) => this.serializeChannel(channel)),
    };
  }

  @Post('categories')
  async createCategory(@Req() request: FastifyRequest, @Body(new ZodValidationPipe(ownerCategoryCreateSchema)) input: OwnerCategoryCreateInput): Promise<OwnerCatalog> {
    const ownerId = getOwnerContext(request).userId;
    if (input.parentId) {
      const parent = await this.prisma.category.findFirst({ where: { id: input.parentId, channels: { some: { variants: { some: { source: { ownerId } } } } } } });
      if (!parent) throw new Error('Dossier parent introuvable');
    }
    const slug = await this.uniqueSlug(input.name);
    const maxSort = await this.prisma.category.aggregate({ _max: { sortOrder: true } });
    const created = await this.prisma.category.create({ data: { name: input.name.trim(), slug, parentId: input.parentId ?? null, sortOrder: (maxSort._max.sortOrder ?? 0) + 1 } });
    await this.audit.log(ownerId, 'catalog.category_create', 'category', created.id, { name: created.name, parentId: created.parentId });
    return this.catalog(request);
  }

  @Patch('categories/:id')
  async updateCategory(@Req() _request: FastifyRequest, @Param('id') id: string, @Body(new ZodValidationPipe(ownerCategoryUpdateSchema)) input: OwnerCategoryUpdateInput): Promise<OwnerCatalog> {
    const ownerId = getOwnerContext(_request).userId;
    const category = await this.prisma.category.findFirst({ where: { id, channels: { some: { variants: { some: { source: { ownerId } } } } } } });
    if (!category) throw new Error('Catégorie introuvable');
    if (input.parentId && input.parentId === id) throw new Error('Un dossier ne peut pas être son propre parent');
    await this.prisma.category.update({ where: { id }, data: { ...(input.name === undefined ? {} : { name: input.name.trim() }), ...(input.isVisible === undefined ? {} : { isVisible: input.isVisible }), ...(input.parentId === undefined ? {} : { parentId: input.parentId }) } });
    await this.audit.log(ownerId, 'catalog.category_update', 'category', id, input);
    return this.catalog(_request);
  }

  @Patch('channels/:id')
  async updateChannel(@Req() request: FastifyRequest, @Param('id') id: string, @Body(new ZodValidationPipe(ownerChannelUpdateSchema)) input: OwnerChannelUpdateInput): Promise<OwnerCatalog> {
    const ownerId = getOwnerContext(request).userId;
    const channel = await this.prisma.channel.findFirst({ where: { id, variants: { some: { source: { ownerId } } } } });
    if (!channel) throw new Error('Chaîne introuvable');
    await this.prisma.channel.update({ where: { id }, data: { ...(input.name === undefined ? {} : { name: input.name.trim(), canonicalName: input.name.trim() }), ...(input.isVisible === undefined ? {} : { isVisible: input.isVisible }) } });
    await this.audit.log(ownerId, 'catalog.channel_update', 'channel', id, input);
    return this.catalog(request);
  }

  @Post('channels/:id/test')
  async testChannel(@Req() request: FastifyRequest, @Param('id') id: string): Promise<ChannelTestResponse> {
    const ownerId = getOwnerContext(request).userId;
    const channel = await this.prisma.channel.findFirst({ where: { id, variants: { some: { source: { ownerId } } } }, include: { variants: { where: { source: { ownerId }, isActive: true }, select: { id: true, encryptedLocator: true } } } });
    if (!channel) throw new Error('Chaîne introuvable');
    let ok = false;
    for (const variant of channel.variants) if ((await this.health.checkVariant(variant)) === 'OK') { ok = true; break; }
    await this.audit.log(ownerId, 'catalog.channel_test', 'channel', id, { checked: channel.variants.length, ok });
    return { ok, status: ok ? 'OK' : 'DOWN', checked: channel.variants.length };
  }

  @Get('profile')
  async profile(@Req() request: FastifyRequest): Promise<OwnerProfile> {
    const ownerId = getOwnerContext(request).userId;
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    return { id: user.id, email: user.email, role: user.role, whatsappContact: user.whatsappContact ?? null };
  }

  @Patch('profile')
  async updateProfile(@Req() request: FastifyRequest, @Body(new ZodValidationPipe(ownerProfileUpdateSchema)) input: OwnerProfileUpdateInput): Promise<OwnerProfile> {
    const ownerId = getOwnerContext(request).userId;
    if (input.whatsappContact !== undefined) {
      const value = input.whatsappContact?.trim() || null;
      await this.prisma.user.update({ where: { id: ownerId }, data: { whatsappContact: value } });
    }
    return this.profile(request);
  }

  @Get('audit')
  async auditEntries(@Req() request: FastifyRequest, @Query(new ZodValidationPipe(auditQuerySchema)) query: { limit?: number; offset?: number }): Promise<{ items: AuditEntry[]; total: number }> {
    const ownerId = getOwnerContext(request).userId; const where = { actorId: ownerId };
    const [items, total] = await Promise.all([this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: query.limit ?? 50, skip: query.offset ?? 0 }) as unknown as Promise<AuditRow[]>, this.prisma.auditLog.count({ where }) as unknown as Promise<number>]);
    return { items: items.map((entry: AuditRow) => this.serializeAudit(entry)), total };
  }

  private async uniqueSlug(base: string): Promise<string> {
    const slug = slugify(base) || 'dossier';
    let candidate = slug;
    let suffix = 1;
    while (await this.prisma.category.findUnique({ where: { slug: candidate } })) {
      candidate = `${slug}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private serializeChannel(channel: OwnerChannelRow): OwnerChannel {
    const healthStatus = channel.variants.some((variant) => variant.healthStatus === 'OK') ? 'OK' : channel.variants.some((variant) => variant.healthStatus === 'DOWN') ? 'DOWN' : null;
    return { id: channel.id, name: channel.name, canonicalName: channel.canonicalName, categoryId: channel.categoryId, isVisible: channel.isVisible, healthStatus: healthStatus as 'OK' | 'DOWN' | null, variantsCount: channel._count.variants };
  }
  private serializeAudit(entry: AuditRow): AuditEntry { return { id: entry.id, action: entry.action, entity: entry.entity, entityId: entry.entityId, actorId: entry.actorId, metadata: (entry.metadata ?? null) as Record<string, unknown> | null, createdAt: entry.createdAt.toISOString() }; }
}
