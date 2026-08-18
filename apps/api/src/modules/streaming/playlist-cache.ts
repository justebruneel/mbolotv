import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export interface CachedPlaylist { content: string; ts: number; }

@Injectable()
export class PlaylistCache implements OnModuleDestroy {
  private readonly memory = new Map<string, CachedPlaylist>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly redis?: Redis;
  private readonly redisPrefix = 'mbolo:stream:playlist:';

  constructor(config: ConfigService) {
    this.ttlMs = Number(config.get('STREAM_PLAYLIST_STALE_TTL_MS', 25_000));
    this.maxEntries = Number(config.get('STREAM_PLAYLIST_CACHE_MAX_ENTRIES', 1000));
    if (config.get<string>('STREAM_PLAYLIST_CACHE', 'memory') === 'redis') {
      const url = config.get<string>('REDIS_URL');
      if (url) this.redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
    }
  }

  async get(sessionId: string, aliasId: string): Promise<string | null> {
    const key = this.key(sessionId, aliasId);
    if (this.redis) {
      try {
        const raw = await this.redis.get(key);
        if (!raw) return null;
        const entry = JSON.parse(raw) as CachedPlaylist;
        if (Date.now() - entry.ts > this.ttlMs) {
          await this.redis.del(key);
          return null;
        }
        return entry.content;
      } catch {
        // Redis is a stale fallback, never a playback hard dependency.
      }
    }
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.memory.delete(key);
      return null;
    }
    return entry.content;
  }

  async set(sessionId: string, aliasId: string, content: string): Promise<void> {
    const entry: CachedPlaylist = { content, ts: Date.now() };
    const key = this.key(sessionId, aliasId);
    if (this.redis) {
      try {
        await this.redis.set(key, JSON.stringify(entry), 'PX', this.ttlMs);
        return;
      } catch {
        // Keep a bounded local fallback if Redis is temporarily unavailable.
      }
    }
    this.memory.set(key, entry);
    this.purgeMemory();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) await this.redis.quit();
  }

  private key(sessionId: string, aliasId: string): string {
    return `${this.redisPrefix}${sessionId}:${aliasId}`;
  }

  private purgeMemory(): void {
    const now = Date.now();
    for (const [key, entry] of this.memory) {
      if (now - entry.ts > this.ttlMs) this.memory.delete(key);
    }
    while (this.memory.size > this.maxEntries) {
      const oldest = this.memory.keys().next().value;
      if (!oldest) break;
      this.memory.delete(oldest);
    }
  }
}
