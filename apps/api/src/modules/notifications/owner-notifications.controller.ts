import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { announcementCreateSchema } from '@mbolo/contracts';
import type { AnnouncementCreateInput } from '@mbolo/contracts';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuditService } from '../../common/audit/audit.service';
import { OwnerAuthGuard } from '../../common/auth/owner-auth.guard';
import { getOwnerContext } from '../../common/auth/owner-context';
import { NotificationsService } from './notifications.service';

/** Console owner : rédiger, publier et supprimer les annonces push. */
@UseGuards(OwnerAuthGuard)
@Controller('owner/notifications')
export class OwnerNotificationsController {
  constructor(private readonly notifications: NotificationsService, private readonly audit: AuditService) {}

  @Get()
  async list() {
    return { items: await this.notifications.ownerList() };
  }

  @Post()
  async create(@Req() request: FastifyRequest, @Body(new ZodValidationPipe(announcementCreateSchema)) body: AnnouncementCreateInput) {
    const { userId } = getOwnerContext(request);
    const created = await this.notifications.ownerCreate(body);
    await this.audit.log(userId, 'notifications.create', 'announcement', created.id, { kind: created.kind });
    return created;
  }

  @Post(':id/publish')
  async publish(@Req() request: FastifyRequest, @Param('id') id: string) {
    const { userId } = getOwnerContext(request);
    const published = await this.notifications.ownerPublish(id);
    await this.audit.log(userId, 'notifications.publish', 'announcement', id, {});
    return published;
  }

  @Delete(':id')
  async remove(@Req() request: FastifyRequest, @Param('id') id: string) {
    const { userId } = getOwnerContext(request);
    const result = await this.notifications.ownerRemove(id);
    await this.audit.log(userId, 'notifications.delete', 'announcement', id, {});
    return result;
  }
}
