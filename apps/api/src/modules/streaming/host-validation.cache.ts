import { BadGatewayException } from '@nestjs/common';
import { assertSafeUrl } from '../sources/safe-fetcher';

const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;

/**
 * Cache de validation SSRF par hostname : la résolution DNS (lookup) n'est
 * faite qu'une fois par hôte (TTL 10 min) au lieu d'à chaque segment/playlist.
 * La sécurité reste identique (protocole, IP privées refusées), seul le coût
 * réseau de la vérification change. Les échecs ne sont jamais mémorisés.
 */
export class HostValidationCache {
  private readonly cache = new Map<string, number>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  async assertSafeHost(url: URL): Promise<void> {
    const hostname = url.hostname.toLowerCase();
    const expiresAt = this.cache.get(hostname);
    if (expiresAt !== undefined && expiresAt > Date.now()) return;

    try {
      await assertSafeUrl(url.toString());
    } catch {
      throw new BadGatewayException('Hôte fournisseur non autorisé');
    }
    this.remember(hostname);
  }

  get size(): number {
    return this.cache.size;
  }

  private remember(hostname: string): void {
    const now = Date.now();
    if (this.cache.size >= MAX_ENTRIES) {
      let oldestHost: string | undefined;
      let oldestExpiry = Infinity;
      for (const [host, expiry] of this.cache) {
        if (expiry <= now) {
          this.cache.delete(host);
        } else if (expiry < oldestExpiry) {
          oldestExpiry = expiry;
          oldestHost = host;
        }
      }
      if (this.cache.size >= MAX_ENTRIES && oldestHost !== undefined) {
        this.cache.delete(oldestHost);
      }
    }
    this.cache.set(hostname, now + this.ttlMs);
  }
}