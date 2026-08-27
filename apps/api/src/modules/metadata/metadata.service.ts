import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TmdbProvider, TmdbEnriched } from './tmdb.provider';

function normalizeKey(title: string, year?: number | null): string {
  return `${title.trim().toLowerCase().replace(/\s+/g, ' ')}::${year ?? ''}`;
}

@Injectable()
export class MetadataService {
  private readonly logger = new Logger(MetadataService.name);
  private readonly tmdb: TmdbProvider;
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.tmdb = new TmdbProvider(config);
    this.enabled = this.tmdb.isEnabled();
    if (!this.enabled) this.logger.warn('TMDB non configuré (TMDB_API_KEY ou TMDB_READ_TOKEN manquant) — enrichissement désactivé, EPG reste fonctionnel');
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async enrich(title: string, typeHint?: string, yearHint?: number | null): Promise<TmdbEnriched | null> {
    if (!this.enabled || !title.trim()) return null;
    const key = normalizeKey(title, yearHint);
    // Cache (via any pour compatibilité avant migration)
    const prismaAny = this.prisma as unknown as { tmdbCache?: { findUnique: (args: unknown) => Promise<{ payload: unknown; expiresAt: Date } | null>; delete: (args: unknown) => Promise<unknown>; create: (args: unknown) => Promise<unknown> } };
    try {
      const cached = await prismaAny.tmdbCache?.findUnique({ where: { cacheKey: key } });
      if (cached && new Date(cached.expiresAt).getTime() > Date.now()) {
        return cached.payload as unknown as TmdbEnriched;
      }
      if (cached) await prismaAny.tmdbCache?.delete({ where: { cacheKey: key } }).catch(() => {});
    } catch {}
    // Types non enrichissables : sport/news/kids -> skip TMDB pour économiser quota
    if (typeHint && ['sports', 'news', 'kids'].includes(typeHint)) return null;
    const result = await this.tmdb.search(title, yearHint ?? undefined);
    if (result) {
      const expiresAt = new Date(Date.now() + 30 * 24 * 3600_000);
      await prismaAny.tmdbCache
        ?.create({ data: { cacheKey: key, title: title.slice(0, 120), year: yearHint ?? result.year, payload: result as unknown as object, expiresAt } })
        .catch(() => {});
    }
    return result;
  }

  async enrichBatch(titles: Array<{ title: string; type?: string; year?: number | null }>): Promise<Map<string, TmdbEnriched>> {
    const unique = new Map<string, { title: string; type?: string; year?: number | null }>();
    for (const t of titles) {
      const k = normalizeKey(t.title, t.year);
      if (!unique.has(k) && t.title.trim()) unique.set(k, t);
    }
    const out = new Map<string, TmdbEnriched>();
    // Séquentiel pour respecter 40 req/10s TMDB, mais cache évite la plupart
    for (const [k, v] of unique) {
      const enriched = await this.enrich(v.title, v.type, v.year);
      if (enriched) out.set(k, enriched);
      // Petit délai si non caché (évite burst)
      if (enriched) await new Promise((r) => setTimeout(r, 120));
    }
    return out;
  }
}
