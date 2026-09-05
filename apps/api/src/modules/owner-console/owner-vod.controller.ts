import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { OwnerVodAvailableCategory, OwnerVodCatalog, OwnerVodFolder, OwnerVodFolderCreateInput, OwnerVodFolderUpdateInput, OwnerVodItemAssignInput, OwnerVodItemSummary, OwnerVodRulesPutInput, OwnerVodYoutubeCreateInput, OwnerVodYoutubeSource, OwnerVodYoutubeUpdateInput, VodFolderKind } from '@mbolo/contracts';
import { ownerVodFolderCreateSchema, ownerVodFolderUpdateSchema, ownerVodItemAssignSchema, ownerVodItemsAddSchema, ownerVodRulesPutSchema, ownerVodYoutubeCreateSchema, ownerVodYoutubeUpdateSchema } from '@mbolo/contracts';
import { z } from 'zod';
import { getOwnerContext } from '../../common/auth/owner-context';
import { OwnerAuthGuard } from '../../common/auth/owner-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuditService } from '../../common/audit/audit.service';
import { slugify } from '../../common/normalize/slugify';

// Catalogue VOD de la console : dossiers en arbre (miroir des catégories de
// chaînes), règles automatiques sur le categoryTitle fournisseur normalisé,
// affectations manuelles item↔dossier et sources YouTube rattachées.
// Mêmes routes que workers/mbolo-tv-api/src/owner-routes.js (/api/owner/vod/*).

const vodItemsQuerySchema = z.object({
  folderId: z.string().optional(), // 'none' = sans dossier ; absent = tout le catalogue
  q: z.string().trim().max(120).optional(),
  kind: z.enum(['MOVIE', 'SERIES']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
const availableCategoriesQuerySchema = z.object({ kind: z.enum(['MOVIE', 'SERIES']).optional() });

/** Clé de règle : la normalisation doit rester conforme au backfill SQL de la migration 20260905000000 (lower(trim(...))). */
const categoryKey = (title: string): string => title.trim().toLowerCase();

type VodFolderRow = { id: string; slug: string; name: string; kind: string; parentId: string | null; isVisible: boolean; sortOrder: number };
type RuleRow = { folderId: string; categoryKey: string; categoryTitle: string };
type SourceRow = { id: string; folderId: string; channelId: string; label: string | null; isActive: boolean; sortOrder: number };

@UseGuards(OwnerAuthGuard)
@Controller('owner/vod')
export class OwnerVodController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get('catalog')
  async catalog(@Req() request: FastifyRequest): Promise<OwnerVodCatalog> {
    const ownerId = getOwnerContext(request).userId;
    const itemScope = { source: { ownerId }, isActive: true } as const;
    const [folderRows, ruleRows, sourceRows, manualCounts, keyCounts] = await Promise.all([
      this.prisma.vodFolder.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }) as unknown as Promise<VodFolderRow[]>,
      this.prisma.vodFolderRule.findMany({ select: { folderId: true, categoryKey: true, categoryTitle: true } }) as unknown as Promise<RuleRow[]>,
      this.prisma.vodYoutubeSource.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }) as unknown as Promise<SourceRow[]>,
      this.prisma.vodFolderItem.groupBy({ by: ['folderId'], where: { vodItem: itemScope }, _count: { vodItemId: true } }) as unknown as Promise<Array<{ folderId: string; _count: { vodItemId: number } }>>,
      this.prisma.vodItem.groupBy({ by: ['categoryKey'], where: { ...itemScope, categoryKey: { not: null } }, _count: { _all: true } }) as unknown as Promise<Array<{ categoryKey: string | null; _count: { _all: number } }>>,
    ]);

    const rulesByFolder = new Map<string, RuleRow[]>();
    for (const rule of ruleRows) { const list = rulesByFolder.get(rule.folderId) ?? []; list.push(rule); rulesByFolder.set(rule.folderId, list); }
    const sourcesByFolder = new Map<string, OwnerVodYoutubeSource[]>();
    for (const source of sourceRows) { const list = sourcesByFolder.get(source.folderId) ?? []; list.push(source); sourcesByFolder.set(source.folderId, list); }
    const manualByFolder = new Map<string, number>(manualCounts.map((row) => [row.folderId, Number(row._count.vodItemId)]));
    const countByKey = new Map<string, number>(keyCounts.filter((row) => row.categoryKey != null).map((row) => [row.categoryKey as string, Number(row._count._all)]));
    const allRuleKeys = Array.from(new Set(ruleRows.map((rule) => rule.categoryKey)));

    // itemCount = règles ∪ manuel, dédupé : on retire le recouvrement (items
    // manuels déjà apportés par une règle du même dossier).
    const foldersWithRules = folderRows.filter((folder) => (rulesByFolder.get(folder.id)?.length ?? 0) > 0);
    const overlaps = await Promise.all(foldersWithRules.map(async (folder) => {
      const keys = (rulesByFolder.get(folder.id) ?? []).map((rule) => rule.categoryKey);
      const count = await this.prisma.vodFolderItem.count({ where: { folderId: folder.id, vodItem: { ...itemScope, categoryKey: { in: keys } } } }) as unknown as number;
      return [folder.id, Number(count)] as const;
    }));
    const overlapByFolder = new Map<string, number>(overlaps);

    const unsortedWhere = {
      ...itemScope,
      folders: { none: {} },
      ...(allRuleKeys.length > 0 ? { OR: [{ categoryKey: null }, { categoryKey: { notIn: allRuleKeys } }] } : {}),
    };
    const unsortedCount = await this.prisma.vodItem.count({ where: unsortedWhere }) as unknown as number;

    // Visibilité effective cycle-safe (copie de l'algo de owner-console.controller).
    const byId = new Map(folderRows.map((folder) => [folder.id, folder] as const));
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
    folderRows.forEach((folder) => computeEffective(folder.id));

    const childrenByParent = new Map<string | null, VodFolderRow[]>();
    for (const folder of folderRows) { const bucket = childrenByParent.get(folder.parentId) ?? []; bucket.push(folder); childrenByParent.set(folder.parentId, bucket); }
    const roots = folderRows.filter((folder) => folder.parentId == null || !byId.has(folder.parentId));

    const visitingNodes = new Set<string>();
    const serializeNode = (node: VodFolderRow): OwnerVodFolder => {
      if (visitingNodes.has(node.id)) return { id: node.id, slug: node.slug, name: node.name, parentId: node.parentId, kind: 'BOTH', isVisible: node.isVisible, effectiveVisible: effective.get(node.id) ?? node.isVisible, sortOrder: node.sortOrder, itemCount: 0, rules: [], youtubeSources: [], children: [] };
      visitingNodes.add(node.id);
      const rules = (rulesByFolder.get(node.id) ?? []).map((rule) => ({ categoryKey: rule.categoryKey, categoryTitle: rule.categoryTitle }));
      const manual = manualByFolder.get(node.id) ?? 0;
      const fromRules = rules.reduce((sum, rule) => sum + (countByKey.get(rule.categoryKey) ?? 0), 0);
      const itemCount = manual + fromRules - (overlapByFolder.get(node.id) ?? 0);
      const children = (childrenByParent.get(node.id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)).map(serializeNode);
      visitingNodes.delete(node.id);
      return {
        id: node.id, slug: node.slug, name: node.name, kind: node.kind as VodFolderKind, parentId: node.parentId,
        isVisible: node.isVisible, effectiveVisible: effective.get(node.id) ?? node.isVisible, sortOrder: node.sortOrder,
        itemCount: Math.max(0, itemCount), rules, youtubeSources: sourcesByFolder.get(node.id) ?? [], children,
      };
    };

    return { folders: roots.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)).map(serializeNode), unsortedCount };
  }

  @Get('catalog/items')
  async catalogItems(@Req() request: FastifyRequest, @Query(new ZodValidationPipe(vodItemsQuerySchema)) query: { folderId?: string; q?: string; kind?: 'MOVIE' | 'SERIES'; limit?: number; offset?: number }): Promise<{ items: OwnerVodItemSummary[]; total: number }> {
    const ownerId = getOwnerContext(request).userId;
    const where: Record<string, unknown> = { source: { ownerId }, isActive: true };
    let ruleKeys: string[] = [];
    if (query.folderId === 'none') {
      const usedKeys = (await this.prisma.vodFolderRule.findMany({ select: { categoryKey: true }, distinct: ['categoryKey'] }) as unknown as Array<{ categoryKey: string }>);
      const keys = usedKeys.map((row) => row.categoryKey);
      where.folders = { none: {} };
      if (keys.length > 0) where.OR = [{ categoryKey: null }, { categoryKey: { notIn: keys } }];
    } else if (query.folderId) {
      const folder = await this.prisma.vodFolder.findUnique({ where: { id: query.folderId }, select: { id: true } });
      if (!folder) throw new NotFoundException('Dossier introuvable');
      ruleKeys = (await this.prisma.vodFolderRule.findMany({ where: { folderId: folder.id }, select: { categoryKey: true } }) as unknown as Array<{ categoryKey: string }>).map((row) => row.categoryKey);
      const or: unknown[] = [{ folders: { some: { folderId: folder.id } } }];
      if (ruleKeys.length > 0) or.push({ categoryKey: { in: ruleKeys } });
      where.OR = or;
    }
    if (query.kind) where.kind = query.kind;
    if (query.q) where.title = { contains: query.q, mode: 'insensitive' };
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const [rows, total] = await Promise.all([
      this.prisma.vodItem.findMany({ where, orderBy: [{ title: 'asc' }, { id: 'asc' }], take: limit, skip: offset, select: { id: true, kind: true, title: true, posterUrl: true, categoryTitle: true, isVisible: true, categoryKey: true, folders: { select: { folderId: true } } } }) as unknown as Promise<Array<{ id: string; kind: string; title: string; posterUrl: string | null; categoryTitle: string | null; isVisible: boolean; categoryKey: string | null; folders: Array<{ folderId: string }> }>>,
      this.prisma.vodItem.count({ where }) as unknown as Promise<number>,
    ]);
    const ruleKeySet = new Set(ruleKeys);
    return {
      items: rows.map((row) => {
        const folderIds = row.folders.map((link) => link.folderId);
        const manual = query.folderId ? folderIds.includes(query.folderId) : folderIds.length > 0;
        const byRule = query.folderId === 'none' ? false : (row.categoryKey != null && ruleKeySet.has(row.categoryKey));
        const matchedBy = manual && byRule ? 'BOTH' : byRule ? 'RULE' : 'MANUAL';
        return { id: row.id, kind: row.kind as 'MOVIE' | 'SERIES', title: row.title, posterUrl: row.posterUrl, categoryTitle: row.categoryTitle, isVisible: row.isVisible, folderIds, matchedBy } satisfies OwnerVodItemSummary;
      }),
      total: Number(total),
    };
  }

  // Libellés categoryTitle distincts du catalogue actif, avec compteurs : le
  // picker du RuleEditor. La page filtre côté client ce que le dossier porte
  // déjà — une même clé peut nourrir plusieurs dossiers (voulu).
  @Get('categories/available')
  async availableCategories(@Req() request: FastifyRequest, @Query(new ZodValidationPipe(availableCategoriesQuerySchema)) query: { kind?: 'MOVIE' | 'SERIES' }): Promise<OwnerVodAvailableCategory[]> {
    const ownerId = getOwnerContext(request).userId;
    const groups = (await this.prisma.vodItem.groupBy({
      by: ['categoryKey'],
      where: { source: { ownerId }, isActive: true, categoryKey: { not: null }, ...(query.kind ? { kind: query.kind } : {}) },
      _count: { _all: true },
      orderBy: { categoryKey: 'asc' }, // requis par Prisma dès qu'on limite (take) ; tri effectif en JS par compteurs
      take: 400,
    }) as unknown as Array<{ categoryKey: string | null; _count: { _all: number } }>);
    groups.sort((a, b) => Number(b._count._all) - Number(a._count._all));
    const keys = groups.map((group) => group.categoryKey).filter((key): key is string => key != null).slice(0, 300);
    // Un libellé représentatif par clé (le même key peut couvrir des variantes de casse).
    const titles = (await this.prisma.vodItem.findMany({ where: { source: { ownerId }, isActive: true, categoryKey: { in: keys } }, select: { categoryKey: true, categoryTitle: true }, distinct: ['categoryKey'] }) as unknown as Array<{ categoryKey: string | null; categoryTitle: string | null }>);
    const titleByKey = new Map(titles.map((row) => [row.categoryKey ?? '', row.categoryTitle ?? '']));
    const countByKey = new Map(groups.map((group) => [group.categoryKey ?? '', Number(group._count._all)]));
    return keys.map((key) => ({ key, title: titleByKey.get(key) || key, count: countByKey.get(key) ?? 0 }));
  }

  @Post('folders')
  async createFolder(@Req() request: FastifyRequest, @Body(new ZodValidationPipe(ownerVodFolderCreateSchema)) input: OwnerVodFolderCreateInput): Promise<OwnerVodCatalog> {
    const ownerId = getOwnerContext(request).userId;
    if (input.parentId && !(await this.prisma.vodFolder.findUnique({ where: { id: input.parentId }, select: { id: true } }))) throw new NotFoundException('Dossier parent introuvable');
    const slug = await this.uniqueSlug(input.name);
    const maxSort = await this.prisma.vodFolder.aggregate({ _max: { sortOrder: true } });
    const created = await this.prisma.vodFolder.create({ data: { name: input.name.trim(), slug, kind: input.kind ?? 'BOTH', parentId: input.parentId ?? null, sortOrder: (maxSort._max.sortOrder ?? 0) + 1 } });
    await this.audit.log(ownerId, 'vod.folder_create', 'vod_folder', created.id, { name: created.name, parentId: created.parentId });
    return this.catalog(request);
  }

  @Patch('folders/:id')
  async updateFolder(@Req() request: FastifyRequest, @Param('id') id: string, @Body(new ZodValidationPipe(ownerVodFolderUpdateSchema)) input: OwnerVodFolderUpdateInput): Promise<OwnerVodCatalog> {
    const ownerId = getOwnerContext(request).userId;
    const folder = await this.prisma.vodFolder.findUnique({ where: { id } });
    if (!folder) throw new NotFoundException('Dossier introuvable');
    if (input.parentId && input.parentId === id) throw new BadRequestException('Un dossier ne peut pas être son propre parent');
    if (input.parentId) {
      let cursor: string | null = input.parentId;
      while (cursor) {
        if (cursor === id) throw new BadRequestException('Un dossier ne peut pas être déplacé dans l’un de ses propres sous-dossiers');
        const parent = await this.prisma.vodFolder.findUnique({ where: { id: cursor }, select: { parentId: true } });
        cursor = parent?.parentId ?? null;
      }
    }

    const targetParent = input.parentId !== undefined ? input.parentId : folder.parentId;
    const ownData: Record<string, unknown> = {};
    if (input.name !== undefined) ownData.name = input.name.trim();
    if (input.kind !== undefined) ownData.kind = input.kind;
    if (input.isVisible !== undefined) ownData.isVisible = input.isVisible;
    if (input.parentId !== undefined) ownData.parentId = input.parentId;

    if (input.sortOrder !== undefined) {
      // Réordonnancement 1-based transactionnel de toute la fratrie (copie de updateCategory).
      const siblings = await this.prisma.vodFolder.findMany({ where: { parentId: targetParent ?? null, NOT: { id } }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
      const ordered = siblings.map((sibling) => sibling.id);
      const clamped = Math.max(0, Math.min(input.sortOrder, ordered.length));
      ordered.splice(clamped, 0, id);
      await this.prisma.$transaction(ordered.map((folderId, index) => this.prisma.vodFolder.update({ where: { id: folderId }, data: { sortOrder: index + 1, ...(folderId === id ? ownData : {}) } })));
    } else {
      if (Object.keys(ownData).length > 0) await this.prisma.vodFolder.update({ where: { id }, data: ownData });
      if (input.parentId !== undefined && input.parentId !== folder.parentId) {
        const max = await this.prisma.vodFolder.aggregate({ where: { parentId: input.parentId }, _max: { sortOrder: true } });
        await this.prisma.vodFolder.update({ where: { id }, data: { sortOrder: (max._max.sortOrder ?? 0) + 1 } });
      }
    }

    await this.audit.log(ownerId, 'vod.folder_update', 'vod_folder', id, input);
    return this.catalog(request);
  }

  @Delete('folders/:id')
  async deleteFolder(@Req() request: FastifyRequest, @Param('id') id: string): Promise<OwnerVodCatalog> {
    const ownerId = getOwnerContext(request).userId;
    const folder = await this.prisma.vodFolder.findUnique({ where: { id } });
    if (!folder) throw new NotFoundException('Dossier introuvable');
    // Les enfants remontent d'un cran ; règles/affectations/sources tombent en
    // cascade → les items redeviennent « sans dossier » (VodItem intact).
    await this.prisma.$transaction([
      this.prisma.vodFolder.updateMany({ where: { parentId: id }, data: { parentId: folder.parentId } }),
      this.prisma.vodFolder.delete({ where: { id } }),
    ]);
    await this.audit.log(ownerId, 'vod.folder_delete', 'vod_folder', id, { name: folder.name });
    return this.catalog(request);
  }

  // Remplacement intégral des règles du dossier (union PUT).
  @Put('folders/:id/rules')
  async putRules(@Req() request: FastifyRequest, @Param('id') id: string, @Body(new ZodValidationPipe(ownerVodRulesPutSchema)) input: OwnerVodRulesPutInput): Promise<OwnerVodCatalog> {
    const ownerId = getOwnerContext(request).userId;
    const folder = await this.prisma.vodFolder.findUnique({ where: { id }, select: { id: true } });
    if (!folder) throw new NotFoundException('Dossier introuvable');
    const seen = new Map<string, string>();
    for (const title of input.categoryTitles) { const clean = title.trim(); if (clean) seen.set(categoryKey(clean), clean); }
    await this.prisma.$transaction([
      this.prisma.vodFolderRule.deleteMany({ where: { folderId: id } }),
      this.prisma.vodFolderRule.createMany({ data: Array.from(seen, ([categoryKeyValue, categoryTitle]) => ({ folderId: id, categoryKey: categoryKeyValue, categoryTitle })) }),
    ]);
    await this.audit.log(ownerId, 'vod.folder_rules', 'vod_folder', id, { count: seen.size });
    return this.catalog(request);
  }

  @Post('folders/:id/items')
  async addItems(@Req() request: FastifyRequest, @Param('id') id: string, @Body(new ZodValidationPipe(ownerVodItemsAddSchema)) input: { itemIds: string[] }): Promise<{ added: number }> {
    const ownerId = getOwnerContext(request).userId;
    const folder = await this.prisma.vodFolder.findUnique({ where: { id }, select: { id: true } });
    if (!folder) throw new NotFoundException('Dossier introuvable');
    const owned = (await this.prisma.vodItem.findMany({ where: { id: { in: input.itemIds }, source: { ownerId }, isActive: true }, select: { id: true } }) as unknown as Array<{ id: string }>);
    const result = await this.prisma.vodFolderItem.createMany({ data: owned.map((row) => ({ folderId: id, vodItemId: row.id })), skipDuplicates: true }) as unknown as { count: number };
    await this.audit.log(ownerId, 'vod.item_assign', 'vod_folder', id, { requested: input.itemIds.length, added: result.count });
    return { added: result.count };
  }

  @Delete('folders/:id/items/:itemId')
  async removeItem(@Req() request: FastifyRequest, @Param('id') id: string, @Param('itemId') itemId: string): Promise<void> {
    const ownerId = getOwnerContext(request).userId;
    const deleted = await this.prisma.vodFolderItem.deleteMany({ where: { folderId: id, vodItemId: itemId } }) as unknown as { count: number };
    if (deleted.count === 0) throw new NotFoundException('Affectation introuvable');
    await this.audit.log(ownerId, 'vod.item_unassign', 'vod_folder', id, { itemId });
  }

  // Réaffectation N-N d'un item : la liste fait foi (vide = sans dossier).
  @Patch('items/:id')
  async assignItem(@Req() request: FastifyRequest, @Param('id') id: string, @Body(new ZodValidationPipe(ownerVodItemAssignSchema)) input: OwnerVodItemAssignInput): Promise<OwnerVodItemSummary> {
    const ownerId = getOwnerContext(request).userId;
    const item = await this.prisma.vodItem.findFirst({ where: { id, source: { ownerId } }, select: { id: true, kind: true, title: true, posterUrl: true, categoryTitle: true, isVisible: true } }) as unknown as { id: string; kind: string; title: string; posterUrl: string | null; categoryTitle: string | null; isVisible: boolean } | null;
    if (!item) throw new NotFoundException('Titre introuvable');
    if (input.folderIds.length > 0) {
      const found = await this.prisma.vodFolder.count({ where: { id: { in: input.folderIds } } }) as unknown as number;
      if (found !== new Set(input.folderIds).size) throw new BadRequestException('Un des dossiers est introuvable');
    }
    const folderIds = Array.from(new Set(input.folderIds));
    await this.prisma.$transaction([
      this.prisma.vodFolderItem.deleteMany({ where: { vodItemId: id } }),
      this.prisma.vodFolderItem.createMany({ data: folderIds.map((folderId) => ({ folderId, vodItemId: id })), skipDuplicates: true }),
      ...(input.isVisible !== undefined ? [this.prisma.vodItem.update({ where: { id }, data: { isVisible: input.isVisible } })] : []),
    ]);
    await this.audit.log(ownerId, 'vod.item_assign', 'vod_item', id, { folderIds });
    return { id: item.id, kind: item.kind as 'MOVIE' | 'SERIES', title: item.title, posterUrl: item.posterUrl, categoryTitle: item.categoryTitle, isVisible: input.isVisible ?? item.isVisible, folderIds, matchedBy: 'MANUAL' };
  }

  @Get('folders/:id/youtube')
  async listYoutube(@Param('id') id: string): Promise<{ items: OwnerVodYoutubeSource[] }> {
    const folder = await this.prisma.vodFolder.findUnique({ where: { id }, select: { id: true } });
    if (!folder) throw new NotFoundException('Dossier introuvable');
    const rows = await this.prisma.vodYoutubeSource.findMany({ where: { folderId: id }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return { items: rows.map((row: SourceRow) => ({ ...row })) };
  }

  @Post('folders/:id/youtube')
  async createYoutube(@Req() request: FastifyRequest, @Param('id') id: string, @Body(new ZodValidationPipe(ownerVodYoutubeCreateSchema)) input: OwnerVodYoutubeCreateInput): Promise<OwnerVodCatalog> {
    const ownerId = getOwnerContext(request).userId;
    const folder = await this.prisma.vodFolder.findUnique({ where: { id }, select: { id: true } });
    if (!folder) throw new NotFoundException('Dossier introuvable');
    const existing = await this.prisma.vodYoutubeSource.count({ where: { folderId: id } }) as unknown as number;
    if (existing >= 10) throw new BadRequestException('Maximum 10 sources YouTube par dossier (quota API)');
    if (existing > 0 && (await this.prisma.vodYoutubeSource.findFirst({ where: { folderId: id, channelId: input.channelId }, select: { id: true } }))) throw new BadRequestException('Cette chaîne est déjà rattachée à ce dossier');
    const created = await this.prisma.vodYoutubeSource.create({ data: { folderId: id, channelId: input.channelId, label: input.label?.trim() || null, sortOrder: existing + 1 } });
    await this.audit.log(ownerId, 'vod.youtube_create', 'vod_youtube_source', created.id, { folderId: id, channelId: created.channelId });
    return this.catalog(request);
  }

  @Patch('youtube/:id')
  async updateYoutube(@Req() request: FastifyRequest, @Param('id') id: string, @Body(new ZodValidationPipe(ownerVodYoutubeUpdateSchema)) input: OwnerVodYoutubeUpdateInput): Promise<OwnerVodCatalog> {
    const ownerId = getOwnerContext(request).userId;
    const source = await this.prisma.vodYoutubeSource.findUnique({ where: { id } });
    if (!source) throw new NotFoundException('Source YouTube introuvable');
    const ownData: Record<string, unknown> = {};
    if (input.label !== undefined) ownData.label = input.label?.trim() || null;
    if (input.isActive !== undefined) ownData.isActive = input.isActive;
    if (input.sortOrder !== undefined) {
      const siblings = await this.prisma.vodYoutubeSource.findMany({ where: { folderId: source.folderId, NOT: { id } }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
      const ordered = siblings.map((sibling) => sibling.id);
      const clamped = Math.max(0, Math.min(input.sortOrder, ordered.length));
      ordered.splice(clamped, 0, id);
      await this.prisma.$transaction(ordered.map((sourceId, index) => this.prisma.vodYoutubeSource.update({ where: { id: sourceId }, data: { sortOrder: index + 1, ...(sourceId === id ? ownData : {}) } })));
    } else if (Object.keys(ownData).length > 0) {
      await this.prisma.vodYoutubeSource.update({ where: { id }, data: ownData });
    }
    await this.audit.log(ownerId, 'vod.youtube_update', 'vod_youtube_source', id, input);
    return this.catalog(request);
  }

  @Delete('youtube/:id')
  async deleteYoutube(@Req() request: FastifyRequest, @Param('id') id: string): Promise<OwnerVodCatalog> {
    const ownerId = getOwnerContext(request).userId;
    const source = await this.prisma.vodYoutubeSource.findUnique({ where: { id } });
    if (!source) throw new NotFoundException('Source YouTube introuvable');
    await this.prisma.vodYoutubeSource.delete({ where: { id } });
    await this.audit.log(ownerId, 'vod.youtube_delete', 'vod_youtube_source', id, { folderId: source.folderId, channelId: source.channelId });
    return this.catalog(request);
  }

  private async uniqueSlug(base: string): Promise<string> {
    const slug = slugify(base) || 'dossier';
    let candidate = slug;
    let suffix = 1;
    while (await this.prisma.vodFolder.findUnique({ where: { slug: candidate } })) {
      candidate = `${slug}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }
}
