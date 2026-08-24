import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface CachedPlaylist { content: string; ts: number; }

@Injectable()
export class PlaylistCache {
  private readonly memory = new Map<string, CachedPlaylist>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(config: ConfigService) {
    this.ttlMs = Number(config.get('STREAM_PLAYLIST_STALE_TTL_MS', 25_000));
    this.maxEntries = Number(config.get('STREAM_PLAYLIST_CACHE_MAX_ENTRIES', 1000));
  }

  async get(sessionId: string, aliasId: string): Promise<string | null> {
    const key = this.key(sessionId, aliasId);
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
    this.memory.set(key, entry);
    this.purgeMemory();
  }

  private key(sessionId: string, aliasId: string): string {
    return `${sessionId}:${aliasId}`;
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
