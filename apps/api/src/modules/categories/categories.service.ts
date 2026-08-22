import { Injectable } from '@nestjs/common';
import type { Category } from '@mbolo/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';

type CategoryRow = { id: string; slug: string; name: string; parentId: string | null; sortOrder: number; isVisible: boolean };

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<Category[]> {
    const categories = await this.prisma.category.findMany({
      select: { id: true, slug: true, name: true, parentId: true, sortOrder: true, isVisible: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }) as unknown as CategoryRow[];
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

    const leaf = new Map<string, number>();
    const counts = await this.prisma.channel.groupBy({ by: ['categoryId'], where: { isVisible: true, variants: { some: { isActive: true } }, categoryId: { not: null } }, _count: { _all: true } });
    for (const row of counts as unknown as Array<{ categoryId: string; _count: { _all: number } }>) leaf.set(row.categoryId, row._count._all);

    const build = (category: CategoryRow): Category => {
      const rawChildren = categories.filter((child) => child.parentId === category.id && effective.get(child.id)).map((child) => build(child));
      const children = rawChildren.filter((child) => (child.channelCount ?? 0) > 0);
      const channelCount = (leaf.get(category.id) ?? 0) + children.reduce((sum, child) => sum + (child.channelCount ?? 0), 0);
      return { id: category.id, slug: category.slug, name: category.name, parentId: category.parentId, isVisible: category.isVisible, channelCount, children };
    };

    return categories
      .filter((category) => effective.get(category.id) && (category.parentId == null || !byId.has(category.parentId) || !effective.get(category.parentId)))
      .map((category) => build(category))
      .filter((category) => (category.channelCount ?? 0) > 0);
  }
}
