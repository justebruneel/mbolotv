import { BadGatewayException, Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
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
const DEFAULT_SEGMENT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_CACHED_SEGMENT_BYTES = 4 * 1024 * 1024;
const PLAYLIST_CACHE_CONTROL = 'public, max-age=0, s-maxage=2, stale-while-revalidate=5';
const SEGMENT_CACHE_CONTROL = 'public, max-age=15, s-maxage=60, stale-while-revalidate=300';

@Controller('stream')
@UseGuards(StreamSessionGuard)
export class StreamingController {
  private readonly maxPlaylistBytes: number;
  private readonly segmentCache: SegmentCache;
  private readonly proxy: StreamProxy;

  constructor(private readonly streamingService: StreamingService, private readonly config: ConfigService, private readonly hostValidation: HostValidationCache, private readonly health: HealthCheckService, private readonly playlistCache: PlaylistCache) {
    this.maxPlaylistBytes = Number(this.config.get('STREAM_MAX_PLAYLIST_BYTES', DEFAULT_MAX_PLAYLIST_BYTES));
    this.segmentCache = new SegmentCache(Number(this.config.get('STREAM_SEGMENT_CACHE_MAX_BYTES', DEFAULT_SEGMENT_CACHE_MAX_BYTES)));
    this.proxy = new StreamProxy(undefined, this.hostValidation);
  }

  @Get(':sessionId/master.m3u8')
  async master(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<FastifyReply> { const context = streamContextOf(request); return this.forward(reply, request, context, await this.streamingService.resolveProviderUrl(context.session), 'master'); }
  @Get(':sessionId/f/:alias')
  async alias(@Param('alias') alias: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<FastifyReply> { const context = streamContextOf(request); return this.forward(reply, request, context, await this.streamingService.resolveProviderUrl(context.session, alias), alias); }

  private async forward(reply: FastifyReply, request: FastifyRequest, context: StreamContext, providerUrl: string, aliasId: string): Promise<FastifyReply> {
    const forwarded: Record<string, string> = {};
    if (typeof request.headers.range === 'string') forwarded.range = request.headers.range;
    const cacheKey = segmentCacheKey(providerUrl);
    if (cacheKey) { const cached = this.segmentCache.get(cacheKey); if (cached) return this.sendBuffered(reply, cached.buffer, cached.contentType, 200, 'HIT'); }
    let response: StreamProxyResponse;
    try { response = await this.proxy.fetch(providerUrl, { headers: forwarded, allowedHostnames: this.streamingService.allowedHostnames(context.session) }); }
    catch (error) {
      if (aliasId === 'master' && context.session.variantId) void this.health.recordFailure(context.session.variantId).catch(() => undefined);
      const stalePlaylist = await this.playlistCache.get(context.session.id, aliasId); if (stalePlaylist) return this.sendPlaylistContent(reply, stalePlaylist);
      if (cacheKey) { const staleSegment = this.segmentCache.get(cacheKey); if (staleSegment) return this.sendBuffered(reply, staleSegment.buffer, staleSegment.contentType, 200, 'STALE'); }
      throw error;
    }
    void this.streamingService.registerDiscoveredHost(context.session, response.finalUrl).catch(() => undefined);
    if (looksLikePlaylist(response.contentType, response.finalUrl)) return this.sendPlaylist(reply, context, response.stream, response.finalUrl, aliasId);
    return this.pipeSegment(reply, response, cacheKey);
  }

  private pipeSegment(reply: FastifyReply, response: StreamProxyResponse, cacheKey: string | null): FastifyReply {
    if (response.contentType) reply.header('content-type', response.contentType);
    if (response.contentLength !== null) reply.header('content-length', response.contentLength);
    if (response.contentRange) reply.header('content-range', response.contentRange);
    if (response.acceptRanges) reply.header('accept-ranges', response.acceptRanges);
    reply.header('cache-control', SEGMENT_CACHE_CONTROL); reply.header('cdn-cache-control', SEGMENT_CACHE_CONTROL); reply.header('x-mbolo-stream-cache', 'MISS'); reply.header('x-accel-buffering', 'no'); reply.status(response.status);
    if (cacheKey) this.teeSegmentToCache(response.stream, cacheKey, response.contentType, MAX_CACHED_SEGMENT_BYTES);
    abortOnDisconnect(reply, response.stream);
    return reply.send(response.stream);
  }

  private teeSegmentToCache(stream: Readable, key: string, contentType: string | null, maxBytes: number): void {
    const chunks: Buffer[] = [];
    let total = 0;
    let cacheable = true;
    stream.on('data', (chunk: Buffer | Uint8Array) => { if (!cacheable) return; const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); total += buffer.byteLength; if (total <= maxBytes) chunks.push(buffer); else { cacheable = false; chunks.length = 0; } });
    stream.once('end', () => { if (cacheable && total > 0) this.segmentCache.set(key, Buffer.concat(chunks), contentType); });
  }

  private sendBuffered(reply: FastifyReply, buffer: Buffer, contentType: string | null, status: number, cacheStatus = 'HIT'): FastifyReply { if (contentType) reply.header('content-type', contentType); reply.header('content-length', String(buffer.byteLength)); reply.header('cache-control', SEGMENT_CACHE_CONTROL); reply.header('cdn-cache-control', SEGMENT_CACHE_CONTROL); reply.header('x-mbolo-stream-cache', cacheStatus); reply.status(status); return reply.send(buffer); }
  private async sendPlaylist(reply: FastifyReply, context: StreamContext, stream: Readable, providerUrl: string, aliasId: string): Promise<FastifyReply> { const content = await readLimited(stream, this.maxPlaylistBytes, 'Playlist'); const rewritten = await rewriteM3u8(content.toString('utf8'), providerUrl, (url) => this.streamingService.registerAlias(context.session, url)); await this.playlistCache.set(context.session.id, aliasId, rewritten); return this.sendPlaylistContent(reply, rewritten); }
  private sendPlaylistContent(reply: FastifyReply, content: string): FastifyReply { reply.header('content-type', 'application/vnd.apple.mpegurl'); reply.header('cache-control', PLAYLIST_CACHE_CONTROL); reply.header('cdn-cache-control', PLAYLIST_CACHE_CONTROL); reply.header('x-mbolo-stream-cache', 'PLAYLIST'); reply.header('x-accel-buffering', 'no'); reply.status(200); return reply.send(content); }
}

function streamContextOf(request: FastifyRequest & { streamContext?: StreamContext }): StreamContext { if (!request.streamContext) throw new BadGatewayException('Contexte de session manquant'); return request.streamContext; }
function looksLikePlaylist(contentType: string | null, url: string): boolean { return Boolean(contentType && /mpegurl/i.test(contentType)) || /\.m3u8(\?|$)/i.test(url); }
function segmentCacheKey(url: string): string | null { try { const parsed = new URL(url); if (/\.m3u8?$/i.test(parsed.pathname)) return null; if (!/\.(?:ts|m4s|mp4|aac|mp3|webm)$/i.test(parsed.pathname)) return null; return `segment:${createHash('sha256').update(url).digest('hex')}`; } catch { return null; } }
async function readLimited(stream: Readable, maxBytes: number, label: string): Promise<Buffer> { const chunks: Buffer[] = []; let size = 0; try { for await (const chunk of stream) { size += chunk.length; if (size > maxBytes) throw new BadGatewayException(`${label} fournisseur trop volumineux`); chunks.push(chunk); } } finally { stream.destroy(); } return Buffer.concat(chunks); }
function abortOnDisconnect(reply: FastifyReply, stream: Readable): void { reply.raw.on('close', () => { if (!reply.raw.writableFinished) stream.destroy(); }); }
