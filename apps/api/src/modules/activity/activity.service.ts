import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

const TTL_MS = 60_000;

@Injectable()
export class ActivityService {
  private readonly memoryGlobal = new Map<string, number>();
  private readonly memoryChannel = new Map<string, Map<string, number>>();

  private deviceKey(ip: string, userAgent?: string): string {
    const raw = `${ip}|${userAgent ?? ''}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  async heartbeat(ip: string, userAgent?: string, channelId?: string): Promise<void> {
    const key = this.deviceKey(ip, userAgent);
    const now = Date.now();
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
    this.pruneMemory(now);
    return this.memoryGlobal.size;
  }

  async getChannelCount(channelId: string): Promise<number> {
    const now = Date.now();
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
