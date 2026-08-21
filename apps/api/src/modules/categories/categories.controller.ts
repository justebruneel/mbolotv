import { Controller, Get, UseGuards } from '@nestjs/common';
import type { Category } from '@mbolo/contracts';
import { AccessGuard } from '../access/access.guard';
import { CategoriesService } from './categories.service';

@UseGuards(AccessGuard)
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  findAll(): Promise<Category[]> {
    return this.categoriesService.findAll();
  }
}
