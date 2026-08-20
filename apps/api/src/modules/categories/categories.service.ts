import { Injectable } from '@nestjs/common';
import type { Category } from '@mbolo/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';

type CategoryRow = { id: string; slug: string; name: string; sortOrder: number; _count: { channels: number } };

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<Category[]> {
    const categories = await this.prisma.category.findMany({
      include: {
        _count: {
          select: { channels: { where: { variants: { some: { isActive: true } } } } },
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return categories
      .map((category: CategoryRow) => ({
        id: category.id,
        slug: category.slug,
        name: category.name,
        channelCount: category._count.channels,
        sortOrder: category.sortOrder,
      }))
      .filter((category: Category) => (category.channelCount ?? 0) > 0);
  }
}
