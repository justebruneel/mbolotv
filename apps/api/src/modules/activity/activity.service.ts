import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';

const TTL_SECONDS = 60;
const TTL_MS = TTL_SECONDS * 1000;

@Injectable()
export class ActivityService implements OnModuleDestroy {
  private readonly redis?: Redis;
  private readonly globalPrefix = 'mbolo:activity:global:';
  private readonly channelPrefix = 'mbolo:activity:channel:';

  // In-memory fallback
  private readonly memoryGlobal = new Map<string, number>();
  private readonly memoryChannel = new Map<string, Map<string, number>>();

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL');
    if (url) {
      try {
        this.redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
      } catch {
        // Fallback to in-memory store
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }

  private deviceKey(ip: string, userAgent?: string): string {
    const raw = `${ip}|${userAgent ?? ''}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  async heartbeat(ip: string, userAgent?: string, channelId?: string): Promise<void> {
    const key = this.deviceKey(ip, userAgent);
    const now = Date.now();

    if (this.redis) {
      try {
        const pipeline = this.redis.pipeline();
        pipeline.set(`${this.globalPrefix}${key}`, now, 'EX', TTL_SECONDS);
        if (channelId) {
          pipeline.set(`${this.channelPrefix}${channelId}:${key}`, now, 'EX', TTL_SECONDS);
        }
        await pipeline.exec();
        return;
      } catch {
        // Fallback to in-memory
      }
    }

    // In-memory fallback
    this.memoryGlobal.set(key, now + TTL_MS);
    if (channelId) {
      let channelMap = this.memoryChannel.get(channelId);
      if (!channelMap) {
        channelMap = new Map<string, number>();
        this.memoryChannel.set(channelId, channelMap);
      }
      channelMap.set(key, now + TTL_MS);
    }
    this.pruneMemory(now);
  }

  async getGlobalCount(): Promise<number> {
    const now = Date.now();

    if (this.redis) {
      try {
        const keys: string[] = [];
        let cursor = '0';
        do {
          const [next, found] = await this.redis.scan(
            cursor,
            'MATCH',
            `${this.globalPrefix}*`,
            'COUNT',
            200,
          );
          cursor = next;
          keys.push(...found);
        } while (cursor !== '0');
        return keys.length;
      } catch {
        // Fallback to in-memory
      }
    }

    this.pruneMemory(now);
    return this.memoryGlobal.size;
  }

  async getChannelCount(channelId: string): Promise<number> {
    const now = Date.now();

    if (this.redis) {
      try {
        const keys: string[] = [];
        let cursor = '0';
        do {
          const [next, found] = await this.redis.scan(
            cursor,
            'MATCH',
            `${this.channelPrefix}${channelId}:*`,
            'COUNT',
            200,
          );
          cursor = next;
          keys.push(...found);
        } while (cursor !== '0');
        return keys.length;
      } catch {
        // Fallback to in-memory
      }
    }

    this.pruneMemory(now);
    const channelMap = this.memoryChannel.get(channelId);
    return channelMap ? channelMap.size : 0;
  }

  private pruneMemory(now: number): void {
    for (const [key, expiresAt] of this.memoryGlobal) {
      if (expiresAt <= now) {
        this.memoryGlobal.delete(key);
      }
    }
    for (const [channelId, channelMap] of this.memoryChannel) {
      for (const [key, expiresAt] of channelMap) {
        if (expiresAt <= now) {
          channelMap.delete(key);
        }
      }
      if (channelMap.size === 0) {
        this.memoryChannel.delete(channelId);
      }
    }
  }
}
