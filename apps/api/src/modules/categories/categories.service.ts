import { Injectable } from '@nestjs/common';
import type { Category } from '@mbolo/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';

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
      .map((category) => ({
        id: category.id,
        slug: category.slug,
        name: category.name,
        channelCount: category._count.channels,
        sortOrder: category.sortOrder,
      }))
      .filter((category) => (category.channelCount ?? 0) > 0);
  }
}
