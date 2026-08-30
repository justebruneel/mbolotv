import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ChannelListResponse } from '@mbolo/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ChannelsService } from '../channels/channels.service';

/**
 * Favoris par appareil : chaque device (en-tête x-device-id envoyé par le web
 * sur toutes ses requêtes) possède sa propre liste, stockée en base — elle
 * survit à un vidage de localStorage et ne fuit pas entre appareils.
 */
@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService, private readonly channels: ChannelsService) {}

  private device(deviceId: string | undefined): string {
    if (!deviceId) throw new BadRequestException('En-tête x-device-id requis');
    return deviceId;
  }

  async list(deviceId: string | undefined): Promise<ChannelListResponse> {
    const rows = await this.prisma.favorite.findMany({ where: { deviceId: this.device(deviceId) }, orderBy: { createdAt: 'desc' } });
    const { items } = await this.channels.listByIds(rows.map((row) => row.channelId));
    // Les favoris les plus récents d'abord ; les chaînes devenues invisibles
    // sont simplement absentes de la réponse.
    const order = new Map(rows.map((row, index) => [row.channelId, index] as const));
    const sorted = [...items].sort((a, b) => (order.get(a.id) ?? items.length) - (order.get(b.id) ?? items.length));
    return { items: sorted, total: sorted.length, hasMore: false };
  }

  async add(deviceId: string | undefined, channelId: string): Promise<{ ok: true }> {
    try {
      await this.prisma.favorite.create({ data: { deviceId: this.device(deviceId), channelId } });
    } catch (error) {
      // P2002 : déjà favori (idempotent) ; P2003 : chaîne inconnue.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') throw new NotFoundException('Channel not found');
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    }
    return { ok: true };
  }

  async remove(deviceId: string | undefined, channelId: string): Promise<{ ok: true }> {
    try {
      await this.prisma.favorite.delete({ where: { deviceId_channelId: { deviceId: this.device(deviceId), channelId } } });
    } catch (error) {
      // P2025 : favori absent — suppression idempotente.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')) throw error;
    }
    return { ok: true };
  }
}
