import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { OwnerAuthModule } from '../owner-auth/owner-auth.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { OwnerNotificationsController } from './owner-notifications.controller';

@Module({
  imports: [AccessModule, OwnerAuthModule],
  controllers: [NotificationsController, OwnerNotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
