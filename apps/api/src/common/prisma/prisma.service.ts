import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  async onModuleInit(): Promise<void> {
    await this.$connect();
    try {
      await this.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
      await this.$queryRawUnsafe('PRAGMA synchronous=NORMAL;');
      await this.$queryRawUnsafe('PRAGMA busy_timeout=30000;');
    } catch (error) { this.logger.warn(`PRAGMAs SQLite non appliqués: ${String(error)}`); }
  }
  async onModuleDestroy(): Promise<void> { await this.$disconnect(); }
}
