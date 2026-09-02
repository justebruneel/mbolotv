import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TvmazeProvider, MetadataEnriched } from './tvmaze.provider';

function normalizeKey(title: string, year?: number | null): string {
  return `${title.trim().toLowerCase().replace(/\s+/g, ' ')}::${year ?? ''}`;
}

/**
 * Enrichissement EPG via sources gratuites (remplace TMDB, incompatible avec
 * notre usage sans accord commercial payant) :
 *  - TVmaze : séries TV, sans clé API (20 req/s) — source principale.
 *  - Fanart.tv : secours image (clé FANART_API_KEY gratuite).
 *  - Films/téléfilms : AUCUNE correspondance TVmaze → texte EPG brut sans
 *    image, fallback silencieux (aucun crash).
 * Cache : table MetadataCache (ex-TmdbCache), TTL 30 jours, clé "titre::année".
 */
@Injectable()
export class MetadataService {
  private readonly logger = new Logger(MetadataService.name);
  private readonly tvmaze: TvmazeProvider;
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.tvmaze = new TvmazeProvider(config);
    // TVmaze ne requiert aucune clé : l'enrichissement est toujours actif.
    // Fanart reste optionnel (FANART_API_KEY) et son échec est silencieux.
    this.enabled = true;
    if (!this.config.get<string>('FANART_API_KEY')) {
      this.logger.log('FANART_API_KEY absente — fallback image Fanart.tv désactivé (TVmaze seul)');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async enrich(title: string, typeHint?: string, yearHint?: number | null): Promise<MetadataEnriched | null> {
    if (!this.enabled || !title.trim()) return null;
    const key = normalizeKey(title, yearHint);
    try {
      const cached = await this.prisma.metadataCache.findUnique({ where: { cacheKey: key } });
      if (cached && new Date(cached.expiresAt).getTime() > Date.now()) {
        const payload = cached.payload as unknown as MetadataEnriched;
        // Payloads hérités de TMDB (sans champ `source`) : obsolètes → purgés.
        if (payload?.source) return payload;
        await this.prisma.metadataCache.delete({ where: { cacheKey: key } }).catch(() => {});
        return null;
      }
      if (cached) await this.prisma.metadataCache.delete({ where: { cacheKey: key } }).catch(() => {});
    } catch {}
    // Types non enrichissables : sport/news/kids -> skip (pas de fiche TVmaze utile)
    if (typeHint && ['sports', 'news', 'kids'].includes(typeHint)) return null;
    const result = await this.tvmaze.search(title, yearHint ?? undefined);
    if (result) {
      const expiresAt = new Date(Date.now() + 30 * 24 * 3600_000);
      await this.prisma.metadataCache
        .create({ data: { cacheKey: key, title: title.slice(0, 120), year: yearHint ?? result.year, payload: result as unknown as object, expiresAt } })
        .catch(() => {});
    }
    return result;
  }

  async enrichBatch(titles: Array<{ title: string; type?: string; year?: number | null }>): Promise<Map<string, MetadataEnriched>> {
    const unique = new Map<string, { title: string; type?: string; year?: number | null }>();
    for (const t of titles) {
      const k = normalizeKey(t.title, t.year);
      if (!unique.has(k) && t.title.trim()) unique.set(k, t);
    }
    const out = new Map<string, MetadataEnriched>();
    // Séquentiel ~8 req/s (limite TVmaze : 20 req/s), le cache absorbe le reste.
    for (const [k, v] of unique) {
      const enriched = await this.enrich(v.title, v.type, v.year);
      if (enriched) out.set(k, enriched);
      // Petit délai si non caché (évite burst)
      if (enriched) await new Promise((r) => setTimeout(r, 120));
    }
    return out;
  }
}
