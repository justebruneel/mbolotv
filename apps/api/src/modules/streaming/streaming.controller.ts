import { BadGatewayException, Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { rewriteM3u8 } from './hls-rewriter';
import { HostValidationCache } from './host-validation.cache';
import { PlaylistCache } from './playlist-cache';
import { SegmentCache } from './segment-cache';
import { StreamProxy, StreamProxyResponse } from './stream-proxy';
import { StreamSessionGuard } from './stream.guard';
import { HealthCheckService } from '../channel-health/channel-health.service';
import { StreamContext, StreamingService } from './streaming.service';

const DEFAULT_MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const DEFAULT_SEGMENT_CACHE_MAX_BYTES = 128 * 1024 * 1024;

@Controller('stream')
@UseGuards(StreamSessionGuard)
export class StreamingController {
  private readonly maxPlaylistBytes: number;
  private readonly segmentCache: SegmentCache;
  private readonly proxy: StreamProxy;

  constructor(
    private readonly streamingService: StreamingService,
    private readonly config: ConfigService,
    private readonly hostValidation: HostValidationCache,
    private readonly health: HealthCheckService,
    private readonly playlistCache: PlaylistCache,
  ) {
    this.maxPlaylistBytes = Number(this.config.get('STREAM_MAX_PLAYLIST_BYTES', DEFAULT_MAX_PLAYLIST_BYTES));
    this.segmentCache = new SegmentCache(Number(this.config.get('STREAM_SEGMENT_CACHE_MAX_BYTES', DEFAULT_SEGMENT_CACHE_MAX_BYTES)));
    this.proxy = new StreamProxy(undefined, this.hostValidation);
  }

  @Get(':sessionId/master.m3u8')
  async master(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<FastifyReply> {
    const context = streamContextOf(request);
    return this.forward(reply, request, context, await this.streamingService.resolveProviderUrl(context.session), 'master');
  }

  @Get(':sessionId/f/:alias')
  async alias(@Param('alias') alias: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<FastifyReply> {
    const context = streamContextOf(request);
    return this.forward(reply, request, context, await this.streamingService.resolveProviderUrl(context.session, alias), alias);
  }

  private async forward(reply: FastifyReply, request: FastifyRequest, context: StreamContext, providerUrl: string, aliasId: string): Promise<FastifyReply> {
    const forwarded: Record<string, string> = {};
    if (typeof request.headers.range === 'string') forwarded.range = request.headers.range;
    let response: StreamProxyResponse;
    try {
      response = await this.proxy.fetch(providerUrl, { headers: forwarded, allowedHostnames: this.streamingService.allowedHostnames(context.session) });
    } catch (error) {
      if (aliasId === 'master' && context.session.variantId) void this.health.recordFailure(context.session.variantId).catch(() => undefined);
      const stalePlaylist = await this.playlistCache.get(context.session.id, aliasId);
      if (stalePlaylist) return this.sendPlaylistContent(reply, stalePlaylist);
      const staleSegment = this.segmentCache.get(`${context.session.id}:${aliasId}`);
      if (staleSegment) return this.sendBuffered(reply, staleSegment.buffer, staleSegment.contentType, 200);
      throw error;
    }
    await this.streamingService.registerDiscoveredHost(context.session, response.finalUrl);
    if (looksLikePlaylist(response.contentType, response.finalUrl)) return this.sendPlaylist(reply, context, response.stream, response.finalUrl, aliasId);
    return this.pipeSegment(reply, response);
  }

  private pipeSegment(reply: FastifyReply, response: StreamProxyResponse): FastifyReply {
    if (response.contentType) reply.header('content-type', response.contentType);
    if (response.contentLength !== null) reply.header('content-length', response.contentLength);
    if (response.contentRange) reply.header('content-range', response.contentRange);
    if (response.acceptRanges) reply.header('accept-ranges', response.acceptRanges);
    reply.header('cache-control', 'no-store, no-transform');
    reply.header('x-accel-buffering', 'no');
    reply.status(response.status);
    abortOnDisconnect(reply, response.stream);
    return reply.send(response.stream);
  }

  private sendBuffered(reply: FastifyReply, buffer: Buffer, contentType: string | null, status: number): FastifyReply {
    if (contentType) reply.header('content-type', contentType);
    reply.header('content-length', String(buffer.byteLength));
    reply.header('cache-control', 'no-store');
    reply.status(status);
    return reply.send(buffer);
  }

  private async sendPlaylist(reply: FastifyReply, context: StreamContext, stream: Readable, providerUrl: string, aliasId: string): Promise<FastifyReply> {
    const content = await readLimited(stream, this.maxPlaylistBytes, 'Playlist');
    const rewritten = await rewriteM3u8(content.toString('utf8'), providerUrl, (url) => this.streamingService.registerAlias(context.session, url));
    await this.playlistCache.set(context.session.id, aliasId, rewritten);
    return this.sendPlaylistContent(reply, rewritten);
  }

  private sendPlaylistContent(reply: FastifyReply, content: string): FastifyReply {
    reply.header('content-type', 'application/vnd.apple.mpegurl');
    reply.header('cache-control', 'no-store, no-transform');
    reply.header('x-accel-buffering', 'no');
    reply.status(200);
    return reply.send(content);
  }
}

function streamContextOf(request: FastifyRequest & { streamContext?: StreamContext }): StreamContext { if (!request.streamContext) throw new BadGatewayException('Contexte de session manquant'); return request.streamContext; }
function looksLikePlaylist(contentType: string | null, url: string): boolean { return Boolean(contentType && /mpegurl/i.test(contentType)) || /\.m3u8(\?|$)/i.test(url); }
async function readLimited(stream: Readable, maxBytes: number, label: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxBytes) throw new BadGatewayException(`${label} fournisseur trop volumineux`);
      chunks.push(chunk);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}
function abortOnDisconnect(reply: FastifyReply, stream: Readable): void { reply.raw.on('close', () => { if (!reply.raw.writableFinished) stream.destroy(); }); }
