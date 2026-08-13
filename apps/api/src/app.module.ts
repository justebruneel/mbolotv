import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';
import { CommonModule } from './common/common.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { QueueModule } from './common/queue/queue.module';
import { StorageModule } from './common/storage/storage.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { EpgModule } from './modules/epg/epg.module';
import { HealthModule } from './modules/health/health.module';
import { MatchesModule } from './modules/matches/matches.module';
import { OwnerAuthModule } from './modules/owner-auth/owner-auth.module';
import { OwnerConsoleModule } from './modules/owner-console/owner-console.module';
import { SourcesModule } from './modules/sources/sources.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        resolve(process.cwd(), '.env'),
        resolve(process.cwd(), '../.env'),
        resolve(process.cwd(), '../../.env'),
      ],
    }),
    CommonModule,
    PrismaModule,
    StorageModule,
    QueueModule,
    HealthModule,
    CategoriesModule,
    ChannelsModule,
    EpgModule,
    MatchesModule,
    OwnerAuthModule,
    OwnerConsoleModule,
    SourcesModule,
  ],
})
export class AppModule {}