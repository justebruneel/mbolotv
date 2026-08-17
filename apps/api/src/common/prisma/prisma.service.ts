import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    // SQLite en mode WAL : les lecteurs ne bloquent plus pendant les écritures
    // (essentiel pour les imports massifs M3U). Les erreurs sont ignorées :
    // d'autres backends ne connaissent pas ces PRAGMAs. $queryRawUnsafe est
    // requis : les PRAGMAs d'affectation renvoient une ligne de résultat.
    try {
      await this.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
      await this.$queryRawUnsafe('PRAGMA busy_timeout=5000;');
    } catch (error) {
      this.logger.warn(`PRAGMAs SQLite non appliqués: ${String(error)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
