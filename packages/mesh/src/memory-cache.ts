// Cache MÉMOIRE des segments — le tier L1 de la hiérarchie (étape 5).
// Derrière lui se trouve persistent-cache.ts (IndexedDB, L2) ; devant, le
// loader sert la mémoire d'abord (jamais on attend IDB si mémoire a, §26).
// Clé = swarmId:cc:sn — JAMAIS l'URL (elle tourne, est re-signée par le proxy).
// Bornes strictes : windowSize segments max (évinction LRU à l'écriture), et
// fenêtre d'annonce = segments récents sous un EVEN cc. `via` accepte 'cache'
// pour les entrées PROMUES depuis le tier persistant (hit IDB → remontée mémoire).
import { MESH_MAX_WINDOW_SEGMENTS } from '@mbolo/contracts';

export interface CachedSegment { bytes: Uint8Array; receivedAt: number; via: 'origin' | 'peer' | 'cache'; sha256: string }

export class SegmentCache {
  private map = new Map<string, CachedSegment>();
  private bytes = 0;

  constructor(private readonly swarmId: string, private readonly maxSegments = MESH_MAX_WINDOW_SEGMENTS * 4) {}

  private key(cc: number, sn: number) { return `${this.swarmId}:${cc}:${sn}`; }

  async put(cc: number, sn: number, bytes: Uint8Array, via: 'origin' | 'peer' | 'cache'): Promise<void> {
    const old = this.map.get(this.key(cc, sn));
    if (old) { this.bytes -= old.bytes.length; this.map.delete(this.key(cc, sn)); }
    this.map.set(this.key(cc, sn), { bytes, receivedAt: Date.now(), via, sha256: await sha256Hex(bytes) });
    this.bytes += bytes.length;
    while (this.map.size > this.maxSegments) {
      const oldest = this.map.keys().next().value as string; // insertion order = ordre des sn (live)
      const evicted = this.map.get(oldest);
      if (evicted) this.bytes -= evicted.bytes.length;
      this.map.delete(oldest);
    }
  }

  get(cc: number, sn: number): CachedSegment | undefined {
    const key = this.key(cc, sn);
    const hit = this.map.get(key);
    if (hit) { this.map.delete(key); this.map.set(key, hit); } // LRU touch
    return hit;
  }

  has(cc: number, sn: number): boolean { return this.map.has(this.key(cc, sn)); }

  /** Fenêtre glissante annoncée au coordinateur : les derniers segments d'un MÊME cc. */
  window(windowSize: number): { cc: number; first: number; last: number } | null {
    let cc = -1; const sns: number[] = [];
    for (const key of [...this.map.keys()].reverse()) {
      const [ccStr, snStr] = key.slice(this.swarmId.length + 1).split(':');
      const c = Number(ccStr);
      const sn = Number(snStr);
      if (cc === -1) cc = c;
      if (c !== cc) break;
      sns.push(sn);
      if (sns.length >= windowSize) break;
    }
    if (!sns.length) return null;
    return { cc, first: Math.min(...sns), last: Math.max(...sns) };
  }

  get size() { return this.map.size; }
  get totalBytes() { return this.bytes; }

  /** Purge complète (changement de rendition : les octets des (cc,sn) passés
   *  ne sont plus compatibles avec le flux courant — spec §6.1, brief §30). */
  clear(): void { this.map.clear(); this.bytes = 0; }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
