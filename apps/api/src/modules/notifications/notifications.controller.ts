import { Body, Controller, Delete, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { pushSubscriptionSchema, reminderCreateSchema } from '@mbolo/contracts';
import type { PushSubscriptionInput, ReminderCreateInput } from '@mbolo/contracts';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AccessGuard } from '../access/access.guard';
import { NotificationsService } from './notifications.service';

/**
 * REST public du PWA (mêmes routes que le Worker en prod) : abonnements push
 * et rappels par appareil, lecture des annonces publiées. Garde d'accès
 * identique au catalogue.
 */
@UseGuards(AccessGuard)
@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post('push/subscribe')
  subscribe(@Headers('x-device-id') deviceId: string | undefined, @Body(new ZodValidationPipe(pushSubscriptionSchema)) body: PushSubscriptionInput) {
    return this.notifications.subscribe(deviceId!, body);
  }

  @Delete('push/subscribe')
  unsubscribe(@Headers('x-device-id') deviceId: string | undefined) {
    return this.notifications.unsubscribe(deviceId!);
  }

  @Get('reminders')
  async listReminders(@Headers('x-device-id') deviceId: string | undefined) {
    return { items: await this.notifications.listReminders(deviceId!) };
  }

  @Post('reminders')
  addReminder(@Headers('x-device-id') deviceId: string | undefined, @Body(new ZodValidationPipe(reminderCreateSchema)) body: ReminderCreateInput) {
    return this.notifications.addReminder(deviceId!, body);
  }

  @Delete('reminders/:programmeId')
  removeReminder(@Headers('x-device-id') deviceId: string | undefined, @Param('programmeId') programmeId: string) {
    return this.notifications.removeReminder(deviceId!, programmeId);
  }

  @Get('announcements')
  async announcements() {
    return { items: await this.notifications.listPublished() };
  }
}
