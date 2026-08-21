import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { Channel, ChannelListResponse, ChannelQuery, CountryOption, PlayResponse, Programme } from '@mbolo/contracts';
import { channelQuerySchema } from '@mbolo/contracts';
import { AccessGuard } from '../access/access.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ChannelsService } from './channels.service';

@UseGuards(AccessGuard)
@Controller('channels')
export class ChannelsController {
  constructor(private readonly channelsService: ChannelsService) {}

  @Get()
  list(@Query(new ZodValidationPipe(channelQuerySchema)) query: ChannelQuery): Promise<ChannelListResponse> { return this.channelsService.list(query); }
  @Get('countries')
  countries(): Promise<CountryOption[]> { return this.channelsService.countries(); }
  @Get(':id')
  findOne(@Param('id') id: string): Promise<Channel> { return this.channelsService.findOne(id); }
  @Get(':id/epg')
  epg(@Param('id') id: string): Promise<Programme[]> { return this.channelsService.epg(id); }
  @Get(':id/play')
  play(@Param('id') id: string): Promise<PlayResponse> { return this.channelsService.play(id); }
}
