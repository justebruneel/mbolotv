import { Injectable } from '@nestjs/common';
import type { Category } from '@mbolo/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<Category[]> {
    const categories = await this.prisma.category.findMany({
      include: { _count: { select: { channels: true } } },
      orderBy: { name: 'asc' },
    });
    return categories.map((category) => ({
      id: category.id,
      slug: category.slug,
      name: category.name,
      channelCount: category._count.channels,
    }));
  }
}
