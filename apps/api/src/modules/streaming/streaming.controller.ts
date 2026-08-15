import {
  BadGatewayException,
  Controller,
  Get,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { rewriteM3u8 } from './hls-rewriter';
import { StreamProxy } from './stream-proxy';
import { StreamSessionGuard } from './stream.guard';
import { StreamContext, StreamingService } from './streaming.service';

const DEFAULT_MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const DEFAULT_PLAYLIST_STALE_TTL_MS = 25_000; // resert une playlist valide ~25 s en cas de pépin fournisseur (durée de rétention typique des segments)
const MAX_CACHED_PLAYLISTS = 1000;

interface CachedPlaylist {
  content: string;
  ts: number;
}

@Controller('stream')
@UseGuards(StreamSessionGuard)
export class StreamingController {
  private readonly maxPlaylistBytes: number;
  private readonly playlistStaleTtlMs: number;
  private readonly playlistCache = new Map<string, CachedPlaylist>();

  constructor(
    private readonly streamingService: StreamingService,
    private readonly config: ConfigService,
  ) {
    this.maxPlaylistBytes = Number(
      this.config.get('STREAM_MAX_PLAYLIST_BYTES', DEFAULT_MAX_PLAYLIST_BYTES),
    );
    this.playlistStaleTtlMs = Number(
      this.config.get('STREAM_PLAYLIST_STALE_TTL_MS', DEFAULT_PLAYLIST_STALE_TTL_MS),
    );
  }

  @Get(':sessionId/master.m3u8')
  master(
    @Param('sessionId') _sessionId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<FastifyReply> {
    const context = streamContextOf(request);
    const providerUrl = this.streamingService.resolveProviderUrl(context.session);
    return this.proxy(reply, request, context, providerUrl, 'master');
  }

  @Get(':sessionId/f/:alias')
  alias(
    @Param('sessionId') _sessionId: string,
    @Param('alias') alias: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<FastifyReply> {
    const context = streamContextOf(request);
    const providerUrl = this.streamingService.resolveProviderUrl(context.session, alias);
    return this.proxy(reply, request, context, providerUrl, alias);
  }

  private async proxy(
    reply: FastifyReply,
    request: FastifyRequest,
    context: StreamContext,
    providerUrl: string,
    aliasId: string,
  ): Promise<FastifyReply> {
    const proxy = new StreamProxy();
    const forwarded: Record<string, string> = {};
    const range = request.headers.range;
    if (typeof range === 'string') forwarded.range = range;

    let response: Awaited<ReturnType<StreamProxy['fetch']>>;
    try {
      response = await proxy.fetch(providerUrl, {
        headers: forwarded,
        allowedHostnames: this.streamingService.allowedHostnames(context.session),
      });
    } catch (error) {
      // Serve-stale : si le fournisseur pêche brièvement sur une playlist, on
      // resert la dernière version valide au lieu de casser la lecture du client.
      const stale = this.getCachedPlaylist(context.session.id, aliasId);
      if (stale) {
        return this.sendPlaylistContent(reply, stale);
      }
      throw error;
    }

    await this.streamingService.registerDiscoveredHost(context.session, response.finalUrl);

    if (looksLikePlaylist(response.contentType, response.finalUrl)) {
      return this.sendPlaylist(reply, context, response.stream, response.finalUrl, aliasId);
    }

    if (response.contentType) reply.header('content-type', response.contentType);
    if (response.contentLength !== null) reply.header('content-length', response.contentLength);
    if (response.contentRange) reply.header('content-range', response.contentRange);
    if (response.acceptRanges) reply.header('accept-ranges', response.acceptRanges);
    reply.header('cache-control', 'no-store');
    reply.status(response.status);
    abortOnDisconnect(reply, response.stream);
    return reply.send(response.stream);
  }

  private async sendPlaylist(
    reply: FastifyReply,
    context: StreamContext,
    stream: Readable,
    providerUrl: string,
    aliasId: string,
  ): Promise<FastifyReply> {
    const content = await readLimited(stream, this.maxPlaylistBytes);

    const rewritten = rewriteM3u8(
      content.toString('utf8'),
      providerUrl,
      (absoluteUrl) => this.streamingService.registerAlias(context.session, absoluteUrl),
    );

    this.cachePlaylist(context.session.id, aliasId, rewritten);
    return this.sendPlaylistContent(reply, rewritten);
  }

  private sendPlaylistContent(reply: FastifyReply, content: string): FastifyReply {
    reply.header('content-type', 'application/vnd.apple.mpegurl');
    reply.header('cache-control', 'no-store');
    reply.status(200);
    return reply.send(content);
  }

  private cachePlaylist(sessionId: string, aliasId: string, content: string): void {
    this.playlistCache.set(`${sessionId}:${aliasId}`, { content, ts: Date.now() });
    // Évite une fuite mémoire : purge des entrées expirées à chaque écriture.
    const now = Date.now();
    for (const [key, entry] of this.playlistCache) {
      if (now - entry.ts > this.playlistStaleTtlMs) {
        this.playlistCache.delete(key);
      }
    }
    // Plafond de taille : évince les entrées les plus anciennes si besoin.
    if (this.playlistCache.size > MAX_CACHED_PLAYLISTS) {
      const oldest = [...this.playlistCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (let i = 0; i < oldest.length && this.playlistCache.size > MAX_CACHED_PLAYLISTS; i += 1) {
        this.playlistCache.delete(oldest[i][0]);
      }
    }
  }

  private getCachedPlaylist(sessionId: string, aliasId: string): string | null {
    const entry = this.playlistCache.get(`${sessionId}:${aliasId}`);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.playlistStaleTtlMs) {
      this.playlistCache.delete(`${sessionId}:${aliasId}`);
      return null;
    }
    return entry.content;
  }
}

function streamContextOf(request: FastifyRequest & { streamContext?: StreamContext }): StreamContext {
  if (!request.streamContext) {
    throw new BadGatewayException('Contexte de session manquant');
  }
  return request.streamContext;
}

function looksLikePlaylist(contentType: string | null, url: string): boolean {
  if (contentType && /mpegurl/i.test(contentType)) return true;
  return /\.m3u8(\?|$)/i.test(url);
}

async function readLimited(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxBytes) {
        throw new BadGatewayException('Playlist fournisseur trop volumineuse');
      }
      chunks.push(chunk);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}

function abortOnDisconnect(reply: FastifyReply, stream: Readable): void {
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) stream.destroy();
  });
}
