import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import * as webpush from 'web-push';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Announcement, AnnouncementCreateInput, PushSubscriptionInput, Reminder, ReminderCreateInput } from '@mbolo/contracts';

interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/**
 * Notifications : abonnements push par appareil, rappels de programmes et
 * annonces administrateur. L'envoi est porté par cette API (cron chaque
 * minute) — le Worker Cloudflare, lui, n'expose que le REST consommé par le
 * PWA, sur la même base.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly pushEnabled: boolean;

  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    const publicKey = config.get<string>('VAPID_PUBLIC_KEY');
    const privateKey = config.get<string>('VAPID_PRIVATE_KEY');
    this.pushEnabled = Boolean(publicKey && privateKey);
    if (this.pushEnabled) {
      webpush.setVapidDetails(config.get<string>('VAPID_SUBJECT') ?? 'mailto:contact@mbolotv.dpdns.org', publicKey!, privateKey!);
    } else {
      this.logger.warn('VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY absents : les notifications push sont désactivées.');
    }
  }

  /* ---------- Abonnements ---------- */

  async subscribe(deviceId: string, input: PushSubscriptionInput): Promise<{ ok: true }> {
    this.requireDevice(deviceId);
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: { deviceId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth },
      update: { deviceId, p256dh: input.keys.p256dh, auth: input.keys.auth },
    });
    return { ok: true };
  }

  async unsubscribe(deviceId: string): Promise<{ ok: true }> {
    this.requireDevice(deviceId);
    await this.prisma.pushSubscription.deleteMany({ where: { deviceId } });
    return { ok: true };
  }

  /* ---------- Rappels ---------- */

  async listReminders(deviceId: string): Promise<Reminder[]> {
    this.requireDevice(deviceId);
    const rows = await this.prisma.programmeReminder.findMany({ where: { deviceId }, orderBy: { startsAt: 'asc' } });
    return rows.map((row) => this.toReminder(row));
  }

  async addReminder(deviceId: string, input: ReminderCreateInput): Promise<Reminder> {
    this.requireDevice(deviceId);
    const row = await this.prisma.programmeReminder.upsert({
      where: { deviceId_programmeId: { deviceId, programmeId: input.programmeId } },
      create: {
        deviceId,
        programmeId: input.programmeId,
        channelId: input.channelId,
        channelName: input.channelName,
        title: input.title,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
      },
      update: { title: input.title, channelName: input.channelName, startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), fired: false },
    });
    return this.toReminder(row);
  }

  async removeReminder(deviceId: string, programmeId: string): Promise<{ ok: true }> {
    this.requireDevice(deviceId);
    await this.prisma.programmeReminder.deleteMany({ where: { deviceId, programmeId } });
    return { ok: true };
  }

  /* ---------- Annonces (lecture publique) ---------- */

  async listPublished(): Promise<Announcement[]> {
    const rows = await this.prisma.announcement.findMany({ where: { status: 'SENT' }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((row) => this.toAnnouncement(row));
  }

  /* ---------- Annonces (console owner) ---------- */

  async ownerList(): Promise<Announcement[]> {
    const rows = await this.prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((row) => this.toAnnouncement(row));
  }

  async ownerCreate(input: AnnouncementCreateInput): Promise<Announcement> {
    const row = await this.prisma.announcement.create({ data: { title: input.title, body: input.body, kind: input.kind ?? 'INFO' } });
    return this.toAnnouncement(row);
  }

  async ownerPublish(id: string): Promise<Announcement> {
    const row = await this.prisma.announcement.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Annonce introuvable');
    const updated = await this.prisma.announcement.update({ where: { id }, data: { status: 'SENT' } });
    return this.toAnnouncement(updated);
  }

  async ownerRemove(id: string): Promise<{ ok: true }> {
    await this.prisma.announcement.deleteMany({ where: { id } });
    return { ok: true };
  }

  /* ---------- Expédition (cron) ---------- */

  @Cron('* * * * *')
  async dispatch(): Promise<void> {
    if (!this.pushEnabled) return;
    await this.dispatchReminders();
    await this.dispatchAnnouncements();
  }

  private async dispatchReminders(): Promise<void> {
    const now = Date.now();
    // Fenêtre [début−1min, début+2min] : tolérance aux démarrages de cron
    // manqués sans jamais prévenir en retard d'un quart d'heure.
    const due = await this.prisma.programmeReminder.findMany({
      where: { fired: false, startsAt: { gte: new Date(now - 60_000), lte: new Date(now + 120_000) } },
    });
    for (const reminder of due) {
      await this.prisma.programmeReminder.update({ where: { deviceId_programmeId: { deviceId: reminder.deviceId, programmeId: reminder.programmeId } }, data: { fired: true } });
      const subs = await this.prisma.pushSubscription.findMany({ where: { deviceId: reminder.deviceId } });
      await this.sendAll(subs, {
        title: reminder.title,
        body: `Commence maintenant sur ${reminder.channelName}`,
        url: `/watch/${reminder.channelId}`,
        tag: `reminder-${reminder.programmeId}`,
      });
    }
    // Les rappels dont l'heure de début est passée depuis plus d'un jour
    // n'ont plus lieu d'être conservés.
    await this.prisma.programmeReminder.deleteMany({ where: { startsAt: { lt: new Date(now - 86_400_000) } } });
  }

  private async dispatchAnnouncements(): Promise<void> {
    const pending = await this.prisma.announcement.findMany({ where: { status: 'SENT', sentAt: null } });
    for (const announcement of pending) {
      const subs = await this.prisma.pushSubscription.findMany({});
      await this.sendAll(subs, {
        title: announcement.title,
        body: announcement.body,
        url: '/whats-new',
        tag: `announcement-${announcement.id}`,
      });
      await this.prisma.announcement.update({ where: { id: announcement.id }, data: { sentAt: new Date() } });
      this.logger.log(`Annonce « ${announcement.title} » poussée à ${subs.length} appareil(s).`);
    }
  }

  private async sendAll(subs: { endpoint: string; p256dh: string; auth: string }[], payload: PushPayload): Promise<void> {
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload));
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          // 404/410 : abonnement mort (navigateur désinscrit) → nettoyage.
          if (status === 404 || status === 410) await this.prisma.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } });
        }
      }),
    );
  }

  /* ---------- Helpers ---------- */

  private requireDevice(deviceId: string | undefined): asserts deviceId is string {
    if (!deviceId?.trim()) throw new BadRequestException('En-tête x-device-id requis');
  }

  private toReminder(row: { programmeId: string; channelId: string; channelName: string; title: string; startsAt: Date; endsAt: Date; fired: boolean }): Reminder {
    return {
      programmeId: row.programmeId,
      channelId: row.channelId,
      channelName: row.channelName,
      title: row.title,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      fired: row.fired,
    };
  }

  private toAnnouncement(row: { id: string; title: string; body: string; kind: string; status: string; createdAt: Date; sentAt: Date | null }): Announcement {
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      kind: row.kind as Announcement['kind'],
      status: row.status as Announcement['status'],
      createdAt: row.createdAt.toISOString(),
      sentAt: row.sentAt?.toISOString() ?? null,
    };
  }
}
