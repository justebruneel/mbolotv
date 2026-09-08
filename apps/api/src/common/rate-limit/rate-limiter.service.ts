import { Injectable } from '@nestjs/common';

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

@Injectable()
export class RateLimiterService {
  private readonly buckets = new Map<string, Bucket>();
  private readonly purgeTimer: NodeJS.Timeout;
  constructor() {
    // Purge périodique : les buckets (session, IP, login) ne sont jamais
    // supprimés sinon, et le Map grossit sans borne. unref() pour ne pas
    // maintenir le process alive en test/CLI.
    this.purgeTimer = setInterval(() => this.purgeExpired(), 60_000);
    this.purgeTimer.unref();
  }
  private purgeExpired(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    // Garde-fou anti-burst : même en période de purge, on plafonne la taille
    // du Map en évictant les buckets les plus anciens.
    const MAX_BUCKETS = 50_000;
    if (this.buckets.size > MAX_BUCKETS) {
      const sortedKeys = [...this.buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt).map(([key]) => key);
      for (let i = 0; i < sortedKeys.length - MAX_BUCKETS; i++) this.buckets.delete(sortedKeys[i]);
    }
  }
  check(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (bucket.count >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }
    bucket.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}