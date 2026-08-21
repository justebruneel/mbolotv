import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  activityHeartbeatSchema,
  type ActiveCountsResponse,
  type ActivityHeartbeatInput,
  type ChannelViewersResponse,
} from '@mbolo/contracts';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ActivityService } from './activity.service';

@Controller('activity')
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Post('heartbeat')
  async heartbeat(
    @Body(new ZodValidationPipe(activityHeartbeatSchema)) input: ActivityHeartbeatInput,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: boolean }> {
    const ip = request.ip || '127.0.0.1';
    const userAgent = request.headers['user-agent'];
    await this.activityService.heartbeat(ip, userAgent, input.channelId);
    return { ok: true };
  }

  @Get('counts')
  async getCounts(): Promise<ActiveCountsResponse> {
    const global = await this.activityService.getGlobalCount();
    return { global };
  }

  @Get('viewers/:channelId')
  async getChannelViewers(@Param('channelId') channelId: string): Promise<ChannelViewersResponse> {
    const count = await this.activityService.getChannelCount(channelId);
    return { count };
  }
}
