const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_TTL_MS = 45_000;
const MAX_ENTRIES = 400;

export interface CachedSegment { buffer: Buffer; contentType: string | null; }

/** Cache mémoire court des segments HLS terminés, partagé par les sessions du process. */
export class SegmentCache {
  private readonly entries = new Map<string, CachedSegment & { ts: number }>();
  private totalBytes = 0;
  constructor(private readonly maxBytes = DEFAULT_MAX_BYTES, private readonly ttlMs = DEFAULT_TTL_MS) {}
  get(key: string): CachedSegment | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttlMs) { this.delete(key); return null; }
    return { buffer: entry.buffer, contentType: entry.contentType };
  }
  set(key: string, buffer: Buffer, contentType: string | null): void {
    if (buffer.byteLength > this.maxBytes) return;
    this.delete(key);
    this.purgeExpired();
    this.evictWhileOverBudget(buffer.byteLength);
    if (this.totalBytes + buffer.byteLength > this.maxBytes || this.entries.size >= MAX_ENTRIES) return;
    this.entries.set(key, { buffer, contentType, ts: Date.now() });
    this.totalBytes += buffer.byteLength;
  }
  get size(): number { return this.entries.size; }
  get bytes(): number { return this.totalBytes; }
  private delete(key: string): void { const entry = this.entries.get(key); if (!entry) return; this.entries.delete(key); this.totalBytes -= entry.buffer.byteLength; }
  private purgeExpired(): void { const now = Date.now(); for (const [key, entry] of this.entries) if (now - entry.ts > this.ttlMs) this.delete(key); }
  private evictWhileOverBudget(incomingBytes: number): void { while (this.totalBytes + incomingBytes > this.maxBytes && this.entries.size > 0) { let oldestKey: string | undefined; let oldestTs = Infinity; for (const [key, entry] of this.entries) if (entry.ts < oldestTs) { oldestTs = entry.ts; oldestKey = key; } if (oldestKey === undefined) break; this.delete(oldestKey); } }
}
