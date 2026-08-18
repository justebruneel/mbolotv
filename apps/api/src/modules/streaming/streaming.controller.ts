import { BadGatewayException, Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { rewriteM3u8 } from './hls-rewriter';
import { HostValidationCache } from './host-validation.cache';
import { SegmentCache } from './segment-cache';
import { StreamProxy, StreamProxyResponse } from './stream-proxy';
import { StreamSessionGuard } from './stream.guard';
import { HealthCheckService } from '../channel-health/channel-health.service';
import { StreamContext, StreamingService } from './streaming.service';

const DEFAULT_MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const DEFAULT_PLAYLIST_STALE_TTL_MS = 25_000;
const MAX_CACHED_PLAYLISTS = 1000;
const DEFAULT_SEGMENT_CACHE_MAX_BYTES = 128 * 1024 * 1024;
interface CachedPlaylist { content: string; ts: number; }

@Controller('stream')
@UseGuards(StreamSessionGuard)
export class StreamingController {
  private readonly maxPlaylistBytes: number;
  private readonly playlistStaleTtlMs: number;
  private readonly playlistCache = new Map<string, CachedPlaylist>();
  private readonly segmentCache: SegmentCache;
  constructor(private readonly streamingService: StreamingService, private readonly config: ConfigService, private readonly hostValidation: HostValidationCache, private readonly health: HealthCheckService) {
    this.maxPlaylistBytes = Number(this.config.get('STREAM_MAX_PLAYLIST_BYTES', DEFAULT_MAX_PLAYLIST_BYTES));
    this.playlistStaleTtlMs = Number(this.config.get('STREAM_PLAYLIST_STALE_TTL_MS', DEFAULT_PLAYLIST_STALE_TTL_MS));
    this.segmentCache = new SegmentCache(Number(this.config.get('STREAM_SEGMENT_CACHE_MAX_BYTES', DEFAULT_SEGMENT_CACHE_MAX_BYTES)));
  }
  @Get(':sessionId/master.m3u8')
  async master(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<FastifyReply> { const context = streamContextOf(request); return this.proxy(reply, request, context, await this.streamingService.resolveProviderUrl(context.session), 'master'); }
  @Get(':sessionId/f/:alias')
  async alias(@Param('alias') alias: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<FastifyReply> { const context = streamContextOf(request); return this.proxy(reply, request, context, await this.streamingService.resolveProviderUrl(context.session, alias), alias); }
  private async proxy(reply: FastifyReply, request: FastifyRequest, context: StreamContext, providerUrl: string, aliasId: string): Promise<FastifyReply> {
    const forwarded: Record<string, string> = {};
    if (typeof request.headers.range === 'string') forwarded.range = request.headers.range;
    const proxy = new StreamProxy(undefined, this.hostValidation);
    let response: StreamProxyResponse;
    try { response = await proxy.fetch(providerUrl, { headers: forwarded, allowedHostnames: this.streamingService.allowedHostnames(context.session) }); }
    catch (error) {
      if (aliasId === 'master' && context.session.variantId) void this.health.recordFailure(context.session.variantId).catch(() => undefined);
      const stale = this.getCachedPlaylist(context.session.id, aliasId); if (stale) return this.sendPlaylistContent(reply, stale);
      const segment = this.segmentCache.get(`${context.session.id}:${aliasId}`); if (segment) return this.sendBuffered(reply, segment.buffer, segment.contentType, 200);
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
    reply.header('cache-control', 'no-store'); reply.header('x-accel-buffering', 'no'); reply.status(response.status); abortOnDisconnect(reply, response.stream); return reply.send(response.stream);
  }
  private sendBuffered(reply: FastifyReply, buffer: Buffer, contentType: string | null, status: number): FastifyReply { if (contentType) reply.header('content-type', contentType); reply.header('content-length', String(buffer.byteLength)); reply.header('cache-control', 'no-store'); reply.status(status); return reply.send(buffer); }
  private async sendPlaylist(reply: FastifyReply, context: StreamContext, stream: Readable, providerUrl: string, aliasId: string): Promise<FastifyReply> {
    const content = await readLimited(stream, this.maxPlaylistBytes, 'Playlist');
    const rewritten = await rewriteM3u8(content.toString('utf8'), providerUrl, (url) => this.streamingService.registerAlias(context.session, url));
    this.cachePlaylist(context.session.id, aliasId, rewritten);
    return this.sendPlaylistContent(reply, rewritten);
  }
  private sendPlaylistContent(reply: FastifyReply, content: string): FastifyReply { reply.header('content-type', 'application/vnd.apple.mpegurl'); reply.header('cache-control', 'no-store'); reply.header('x-accel-buffering', 'no'); reply.status(200); return reply.send(content); }
  private cachePlaylist(sessionId: string, aliasId: string, content: string): void { this.playlistCache.set(`${sessionId}:${aliasId}`, { content, ts: Date.now() }); const now = Date.now(); for (const [key, entry] of this.playlistCache) if (now - entry.ts > this.playlistStaleTtlMs) this.playlistCache.delete(key); if (this.playlistCache.size > MAX_CACHED_PLAYLISTS) this.playlistCache.delete(this.playlistCache.keys().next().value!); }
  private getCachedPlaylist(sessionId: string, aliasId: string): string | null { const entry = this.playlistCache.get(`${sessionId}:${aliasId}`); if (!entry) return null; if (Date.now() - entry.ts > this.playlistStaleTtlMs) { this.playlistCache.delete(`${sessionId}:${aliasId}`); return null; } return entry.content; }
}
function streamContextOf(request: FastifyRequest & { streamContext?: StreamContext }): StreamContext { if (!request.streamContext) throw new BadGatewayException('Contexte de session manquant'); return request.streamContext; }
function looksLikePlaylist(contentType: string | null, url: string): boolean { return Boolean(contentType && /mpegurl/i.test(contentType)) || /\.m3u8(\?|$)/i.test(url); }
async function readLimited(stream: Readable, maxBytes: number, label: string): Promise<Buffer> { const chunks: Buffer[] = []; let size = 0; try { for await (const chunk of stream) { size += chunk.length; if (size > maxBytes) throw new BadGatewayException(`${label} fournisseur trop volumineux`); chunks.push(chunk); } } finally { stream.destroy(); } return Buffer.concat(chunks); }
function abortOnDisconnect(reply: FastifyReply, stream: Readable): void { reply.raw.on('close', () => { if (!reply.raw.writableFinished) stream.destroy(); }); }
