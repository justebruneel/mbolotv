import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';

export interface StreamSession {
  id: string;
  channelId: string;
  variantId: string;
  sourceId: string;
  providerHostname: string;
  deviceId: string;
  discoveredHosts: string[];
  createdAt: number;
  idleExpiresAt: number;
  expiresAt: number;
}

interface AliasEntry { url: string; expiresAt: number; }
type SessionInput = Omit<StreamSession, 'id' | 'createdAt' | 'idleExpiresAt' | 'expiresAt' | 'discoveredHosts'>;

@Injectable()
export abstract class StreamSessionStore {
  abstract create(input: SessionInput, idleTtlMs: number, absoluteTtlMs: number): Promise<StreamSession>;
  abstract get(id: string): Promise<StreamSession | undefined>;
  abstract touch(id: string, idleTtlMs: number): Promise<void>;
  abstract update(session: StreamSession): Promise<void>;
  abstract delete(id: string): Promise<void>;
  abstract addAlias(sessionId: string, alias: string, url: string, ttlMs: number): Promise<void>;
  abstract getAlias(sessionId: string, alias: string): Promise<string | undefined>;
  abstract getAliasByKey(sessionId: string, key: string): Promise<string | undefined>;
  abstract setAliasByKey(sessionId: string, key: string, alias: string): Promise<void>;
  abstract deleteAliases(sessionId: string): Promise<void>;
  abstract prune(now?: number): Promise<void>;
}

@Injectable()
export class InMemoryStreamSessionStore extends StreamSessionStore implements OnModuleInit, OnModuleDestroy {
  private readonly sessions = new Map<string, StreamSession>();
  private readonly aliases = new Map<string, Map<string, AliasEntry>>();
  private readonly keyAliases = new Map<string, Map<string, string>>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly config: ConfigService) { super(); }
  onModuleInit(): void { this.timer = setInterval(() => void this.prune(), Number(this.config.get('STREAM_PRUNE_INTERVAL_MS', 60_000))); this.timer.unref(); }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  async create(input: SessionInput, idleTtlMs: number, absoluteTtlMs: number): Promise<StreamSession> {
    const now = Date.now();
    const session: StreamSession = { ...input, id: randomBytes(18).toString('base64url'), discoveredHosts: [], createdAt: now, idleExpiresAt: now + idleTtlMs, expiresAt: now + absoluteTtlMs };
    this.sessions.set(session.id, session);
    return session;
  }
  async get(id: string): Promise<StreamSession | undefined> { const session = this.sessions.get(id); if (!session) return undefined; if (session.expiresAt <= Date.now() || session.idleExpiresAt <= Date.now()) { await this.delete(id); return undefined; } return session; }
  async touch(id: string, idleTtlMs: number): Promise<void> { const session = await this.get(id); if (!session) return; session.idleExpiresAt = Math.min(Date.now() + idleTtlMs, session.expiresAt); }
  async update(session: StreamSession): Promise<void> { this.sessions.set(session.id, session); }
  async delete(id: string): Promise<void> { this.sessions.delete(id); this.aliases.delete(id); this.keyAliases.delete(id); }
  async addAlias(sessionId: string, alias: string, url: string, ttlMs: number): Promise<void> { if (!this.sessions.has(sessionId)) return; let map = this.aliases.get(sessionId); if (!map) { map = new Map(); this.aliases.set(sessionId, map); } map.set(alias, { url, expiresAt: Date.now() + ttlMs }); }
  async getAlias(sessionId: string, alias: string): Promise<string | undefined> { const entry = this.aliases.get(sessionId)?.get(alias); if (!entry) return undefined; if (entry.expiresAt <= Date.now()) { this.aliases.get(sessionId)?.delete(alias); return undefined; } return entry.url; }
  async getAliasByKey(sessionId: string, key: string): Promise<string | undefined> { return this.keyAliases.get(sessionId)?.get(key); }
  async setAliasByKey(sessionId: string, key: string, alias: string): Promise<void> { let map = this.keyAliases.get(sessionId); if (!map) { map = new Map(); this.keyAliases.set(sessionId, map); } map.set(key, alias); }
  async deleteAliases(sessionId: string): Promise<void> { this.aliases.delete(sessionId); this.keyAliases.delete(sessionId); }
  async prune(now = Date.now()): Promise<void> { for (const [id, session] of this.sessions) if (session.expiresAt <= now || session.idleExpiresAt <= now) await this.delete(id); }
}

@Injectable()
export class RedisStreamSessionStore extends StreamSessionStore implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly prefix = 'mbolo:stream:';
  constructor(config: ConfigService) { super(); this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), { lazyConnect: false, maxRetriesPerRequest: 2 }); }
  onModuleDestroy(): void { void this.redis.quit(); }
  private key(id: string): string { return `${this.prefix}session:${id}`; }
  private aliasKey(id: string): string { return `${this.prefix}aliases:${id}`; }
  private mapKey(id: string): string { return `${this.prefix}alias-keys:${id}`; }
  private async save(session: StreamSession): Promise<void> { const ttl = Math.max(1, Math.min(session.expiresAt - Date.now(), session.idleExpiresAt - Date.now())); await this.redis.set(this.key(session.id), JSON.stringify(session), 'PX', ttl); }
  async create(input: SessionInput, idleTtlMs: number, absoluteTtlMs: number): Promise<StreamSession> { const now = Date.now(); const session: StreamSession = { ...input, id: randomBytes(18).toString('base64url'), discoveredHosts: [], createdAt: now, idleExpiresAt: now + idleTtlMs, expiresAt: now + absoluteTtlMs }; await this.save(session); return session; }
  async get(id: string): Promise<StreamSession | undefined> { const raw = await this.redis.get(this.key(id)); if (!raw) return undefined; const session = JSON.parse(raw) as StreamSession; if (session.expiresAt <= Date.now() || session.idleExpiresAt <= Date.now()) { await this.delete(id); return undefined; } return session; }
  async touch(id: string, idleTtlMs: number): Promise<void> { const session = await this.get(id); if (!session) return; session.idleExpiresAt = Math.min(Date.now() + idleTtlMs, session.expiresAt); await this.save(session); }
  async update(session: StreamSession): Promise<void> { await this.save(session); }
  async delete(id: string): Promise<void> { await this.redis.del(this.key(id), this.aliasKey(id), this.mapKey(id)); }
  async addAlias(sessionId: string, alias: string, url: string, ttlMs: number): Promise<void> { if (!(await this.get(sessionId))) return; await this.redis.hset(this.aliasKey(sessionId), alias, JSON.stringify({ url, expiresAt: Date.now() + ttlMs })); }
  async getAlias(sessionId: string, alias: string): Promise<string | undefined> { const raw = await this.redis.hget(this.aliasKey(sessionId), alias); if (!raw) return undefined; const entry = JSON.parse(raw) as AliasEntry; if (entry.expiresAt <= Date.now()) { await this.redis.hdel(this.aliasKey(sessionId), alias); return undefined; } return entry.url; }
  async getAliasByKey(sessionId: string, key: string): Promise<string | undefined> { return (await this.redis.hget(this.mapKey(sessionId), key)) || undefined; }
  async setAliasByKey(sessionId: string, key: string, alias: string): Promise<void> { await this.redis.hset(this.mapKey(sessionId), key, alias); }
  async deleteAliases(sessionId: string): Promise<void> { await this.redis.del(this.aliasKey(sessionId), this.mapKey(sessionId)); }
  async prune(): Promise<void> { /* Redis TTLs remove expired sessions; alias expiry is checked on read. */ }
}
