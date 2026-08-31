import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { OwnerNotificationsController } from './owner-notifications.controller';

@Module({
  imports: [AccessModule],
  controllers: [NotificationsController, OwnerNotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
