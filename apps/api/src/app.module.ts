import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { resolve } from 'node:path';
import { CommonModule } from './common/common.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { QueueModule } from './common/queue/queue.module';
import { StorageModule } from './common/storage/storage.module';
import { AccessModule } from './modules/access/access.module';
import { ActivityModule } from './modules/activity/activity.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { ChannelHealthModule } from './modules/channel-health/channel-health.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { EpgModule } from './modules/epg/epg.module';
import { FavoritesModule } from './modules/favorites/favorites.module';
import { HealthModule } from './modules/health/health.module';
import { MatchesModule } from './modules/matches/matches.module';
import { OwnerAuthModule } from './modules/owner-auth/owner-auth.module';
import { OwnerConsoleModule } from './modules/owner-console/owner-console.module';
import { SourcesModule } from './modules/sources/sources.module';
import { StreamingModule } from './modules/streaming/streaming.module';

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
    ScheduleModule.forRoot(),
    CommonModule,
    PrismaModule,
    StorageModule,
    QueueModule,
    AccessModule,
    HealthModule,
    ActivityModule,
    CategoriesModule,
    ChannelHealthModule,
    ChannelsModule,
    EpgModule,
    FavoritesModule,
    MatchesModule,
    OwnerAuthModule,
    OwnerConsoleModule,
    SourcesModule,
    StreamingModule,
  ],
})
export class AppModule {}
