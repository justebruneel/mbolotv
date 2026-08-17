const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_TTL_MS = 45_000;
// Plafond d'entrées indépendant du volume (protège contre les micro-segments).
const MAX_ENTRIES = 2000;

export interface CachedSegment {
  buffer: Buffer;
  contentType: string | null;
}

/**
 * Cache mémoire des segments HLS (serve-stale) : si le fournisseur pêche sur
 * un segment (502, timeout, connexion coupée), le client reçoit la dernière
 * version valide au lieu de casser la lecture. Éviction LRU avec plafond de
 * taille globale et TTL court (les segments live ne restent valides que
 * quelques secondes chez le fournisseur).
 */
export class SegmentCache {
  private readonly entries = new Map<string, CachedSegment & { ts: number }>();
  private totalBytes = 0;

  constructor(
    private readonly maxBytes = DEFAULT_MAX_BYTES,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  get(key: string): CachedSegment | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.entries.delete(key);
      this.totalBytes -= entry.buffer.byteLength;
      return null;
    }
    return { buffer: entry.buffer, contentType: entry.contentType };
  }

  set(key: string, buffer: Buffer, contentType: string | null): void {
    if (buffer.byteLength > this.maxBytes) return;

    const existing = this.entries.get(key);
    if (existing) {
      existing.buffer = buffer;
      existing.contentType = contentType;
      existing.ts = Date.now();
      return;
    }

    this.purgeExpired();
    this.evictWhileOverBudget(buffer.byteLength);
    if (this.totalBytes + buffer.byteLength > this.maxBytes) return;
    if (this.entries.size >= MAX_ENTRIES) return;

    this.entries.set(key, { buffer, contentType, ts: Date.now() });
    this.totalBytes += buffer.byteLength;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.ts > this.ttlMs) {
        this.entries.delete(key);
        this.totalBytes -= entry.buffer.byteLength;
      }
    }
  }

  private evictWhileOverBudget(incomingBytes: number): void {
    while (this.totalBytes + incomingBytes > this.maxBytes && this.entries.size > 0) {
      let oldestKey: string | undefined;
      let oldestTs = Infinity;
      for (const [key, entry] of this.entries) {
        if (entry.ts < oldestTs) {
          oldestTs = entry.ts;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      const evicted = this.entries.get(oldestKey);
      if (evicted) this.totalBytes -= evicted.buffer.byteLength;
      this.entries.delete(oldestKey);
    }
  }
}