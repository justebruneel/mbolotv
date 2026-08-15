import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';

export interface StreamSession {
  id: string;
  channelId: string;
  variantId: string;
  sourceId: string;
  providerHostname: string;
  discoveredHosts: string[];
  createdAt: number;
  idleExpiresAt: number;
  expiresAt: number;
}

interface AliasEntry {
  url: string;
  expiresAt: number;
}

const DEFAULT_MAX_SESSIONS = 512;
const DEFAULT_PRUNE_INTERVAL_MS = 60_000;

@Injectable()
export abstract class StreamSessionStore {
  abstract create(
    input: Omit<StreamSession, 'id' | 'createdAt' | 'idleExpiresAt' | 'expiresAt' | 'discoveredHosts'>,
    idleTtlMs: number,
    absoluteTtlMs: number,
  ): StreamSession;

  abstract get(id: string): StreamSession | undefined;
  abstract touch(id: string, idleTtlMs: number): void;
  abstract delete(id: string): void;

  abstract addAlias(sessionId: string, alias: string, url: string, ttlMs: number): void;
  abstract getAlias(sessionId: string, alias: string): string | undefined;
  abstract getAliasByKey(sessionId: string, key: string): string | undefined;
  abstract setAliasByKey(sessionId: string, key: string, alias: string): void;
  abstract deleteAliases(sessionId: string): void;
  abstract prune(now?: number): void;
}

@Injectable()
export class InMemoryStreamSessionStore
  extends StreamSessionStore
  implements OnModuleInit, OnModuleDestroy
{
  private readonly sessions = new Map<string, StreamSession>();
  private readonly aliases = new Map<string, Map<string, AliasEntry>>();
  private readonly keyAliases = new Map<string, Map<string, string>>();
  private readonly maxSessions: number;
  private readonly pruneIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly config: ConfigService) {
    super();
    this.maxSessions = Number(this.config.get('STREAM_MAX_SESSIONS', DEFAULT_MAX_SESSIONS));
    this.pruneIntervalMs = Number(
      this.config.get('STREAM_PRUNE_INTERVAL_MS', DEFAULT_PRUNE_INTERVAL_MS),
    );
  }

  onModuleInit(): void {
    this.timer = setInterval(() => this.prune(), this.pruneIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  create(
    input: Omit<StreamSession, 'id' | 'createdAt' | 'idleExpiresAt' | 'expiresAt' | 'discoveredHosts'>,
    idleTtlMs: number,
    absoluteTtlMs: number,
  ): StreamSession {
    this.evictIfFull();
    const now = Date.now();
    const session: StreamSession = {
      id: randomBytes(18).toString('base64url'),
      channelId: input.channelId,
      variantId: input.variantId,
      sourceId: input.sourceId,
      providerHostname: input.providerHostname,
      discoveredHosts: [],
      createdAt: now,
      idleExpiresAt: now + idleTtlMs,
      expiresAt: now + absoluteTtlMs,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): StreamSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const now = Date.now();
    if (session.expiresAt <= now || session.idleExpiresAt <= now) {
      this.delete(id);
      return undefined;
    }
    return session;
  }

  touch(id: string, idleTtlMs: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const now = Date.now();
    if (session.expiresAt <= now) {
      this.delete(id);
      return;
    }
    session.idleExpiresAt = Math.min(now + idleTtlMs, session.expiresAt);
  }

  delete(id: string): void {
    this.sessions.delete(id);
    this.aliases.delete(id);
    this.keyAliases.delete(id);
  }

  addAlias(sessionId: string, alias: string, url: string, ttlMs: number): void {
    if (!this.sessions.has(sessionId)) return;
    let map = this.aliases.get(sessionId);
    if (!map) {
      map = new Map<string, AliasEntry>();
      this.aliases.set(sessionId, map);
    }
    map.set(alias, { url, expiresAt: Date.now() + ttlMs });
  }

  getAlias(sessionId: string, alias: string): string | undefined {
    const map = this.aliases.get(sessionId);
    if (!map) return undefined;
    const entry = map.get(alias);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      map.delete(alias);
      return undefined;
    }
    return entry.url;
  }

  getAliasByKey(sessionId: string, key: string): string | undefined {
    return this.keyAliases.get(sessionId)?.get(key);
  }

  setAliasByKey(sessionId: string, key: string, alias: string): void {
    if (!this.sessions.has(sessionId)) return;
    let map = this.keyAliases.get(sessionId);
    if (!map) {
      map = new Map<string, string>();
      this.keyAliases.set(sessionId, map);
    }
    map.set(key, alias);
  }

  deleteAliases(sessionId: string): void {
    this.aliases.delete(sessionId);
  }

  prune(now = Date.now()): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now || session.idleExpiresAt <= now) {
        this.sessions.delete(id);
        this.aliases.delete(id);
        continue;
      }
      const map = this.aliases.get(id);
      if (!map) continue;
      for (const [alias, entry] of map) {
        if (entry.expiresAt <= now) map.delete(alias);
      }
      if (map.size === 0) {
        this.aliases.delete(id);
        this.keyAliases.delete(id);
        continue;
      }
      const keyMap = this.keyAliases.get(id);
      if (keyMap) {
        for (const [key, alias] of keyMap) {
          if (!map.has(alias)) keyMap.delete(key);
        }
        if (keyMap.size === 0) this.keyAliases.delete(id);
      }
    }
  }

  private evictIfFull(): void {
    if (this.sessions.size < this.maxSessions) return;
    const oldest = [...this.sessions.entries()].sort(
      (a, b) => a[1].idleExpiresAt - b[1].idleExpiresAt,
    )[0];
    if (oldest) this.delete(oldest[0]);
  }
}
