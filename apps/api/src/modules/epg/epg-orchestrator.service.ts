import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HttpXmltvProvider } from './providers/http-xmltv.provider';
import { normalizeCategoryToType } from './providers/epg-provider.interface';
import { parseXmltvStream } from './xmltv.parser';
import { MetadataService } from '../metadata/metadata.service';

interface RawProgramme {
  channelId: string;
  startsAt: Date;
  endsAt: Date;
  title: string;
  description: string | null;
  imageUrl: string | null;
  categories: string[];
  metadataSource?: string;
}

@Injectable()
export class EpgOrchestrator {
  private readonly logger = new Logger(EpgOrchestrator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly metadata: MetadataService,
  ) {}

  private getExtraProviders(): HttpXmltvProvider[] {
    const extra = this.config.get<string>('EPG_EXTRA_URLS', '');
    const urls = extra
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Par défaut : Europe gratuite. xmltvfr.fr est mort (404) : opt-in via
    // EPG_XMLTVFR_URL uniquement, pour un éventuel miroir futur.
    const defaults: Array<{ name: string; url: string }> = [
      { name: 'iptv-epg-fr', url: this.config.get<string>('EPG_IPTV_EPG_FR_URL', 'https://iptv-epg.org/files/epg-fr.xml.gz') },
    ];
    const xmltvfr = this.config.get<string>('EPG_XMLTVFR_URL', '');
    if (xmltvfr) defaults.push({ name: 'xmltvfr', url: xmltvfr });
    // Afrique : via env EPG_AFRICA_URLS (ex: NG,ZA,CI ...)
    const africaExtra = this.config.get<string>('EPG_AFRICA_URLS', '');
    for (const u of africaExtra.split(',').map((s) => s.trim()).filter(Boolean)) {
      defaults.push({ name: 'africa', url: u });
    }
    // Merge extra surdefaults
    for (const u of urls) defaults.push({ name: 'extra', url: u });
    // Filtre urls vides / non http
    return defaults
      .filter((p) => p.url && /^https?:\/\//i.test(p.url))
      .map((p) => new HttpXmltvProvider(p.name, p.url));
  }

  /**
   * Import multi-fournisseur : fetch parallèle, parse, merge, enrichissement TVmaze/Fanart.tv, persistance
   * Réutilise la logique de mapping existante (tvgMap + nameMap) via le service appelant
   */
  async importExtraEpg(
    tvgMap: Map<string, string>,
    nameMap: Map<string, string>,
    channelEpgMapping?: Map<string, string>,
  ): Promise<{ providers: string[]; totalPrograms: number; stored: number; unmatchedSample: string[] }> {
    const providers = this.getExtraProviders();
    if (providers.length === 0) return { providers: [], totalPrograms: 0, stored: 0, unmatchedSample: [] };

    const allRaw: RawProgramme[] = [];
    const unmatched = new Map<string, number>();
    const providerNames: string[] = [];

    for (const provider of providers) {
      try {
        this.logger.log(`EPG extra: fetch ${provider.name} ${provider.getSourceUrl()}`);
        const stream = await provider.fetchXmltv();
        const batch: RawProgramme[] = [];
        await parseXmltvStream(stream as unknown as ReadableStream<Uint8Array>, async (programmes) => {
          for (const p of programmes) {
            batch.push({
              channelId: p.channelId,
              startsAt: p.startsAt,
              endsAt: p.endsAt,
              title: p.title,
              description: p.description ?? null,
              imageUrl: p.imageUrl ?? null,
              categories: p.categories ?? [],
              metadataSource: provider.name,
            });
          }
          return 0;
        });
        allRaw.push(...batch);
        providerNames.push(provider.name);
        this.logger.log(`EPG ${provider.name}: ${batch.length} programmes`);
      } catch (error) {
        this.logger.warn(`EPG ${provider.name} échoué: ${String((error as Error).message ?? error)}`);
      }
    }

    // Mapping vers channelId interne
    const resolved: Array<RawProgramme & { channelIdInternal: string }> = [];
    for (const prog of allRaw) {
      const key = prog.channelId.toLowerCase().trim();
      const mapped =
        tvgMap.get(key) ??
        channelEpgMapping?.get(`${prog.channelId}::${prog.metadataSource}`) ??
        nameMap.get(key.replace(/\s+/g, '').toLowerCase());
      if (mapped) {
        resolved.push({ ...prog, channelIdInternal: mapped });
      } else {
        unmatched.set(prog.channelId, (unmatched.get(prog.channelId) ?? 0) + 1);
      }
    }

    // Déduplication (channelId, startsAt) — priorité au premier provider (ordre getExtraProviders)
    const dedup = new Map<string, RawProgramme & { channelIdInternal: string }>();
    for (const prog of resolved) {
      const k = `${prog.channelIdInternal}::${prog.startsAt.toISOString()}`;
      if (!dedup.has(k)) dedup.set(k, prog);
    }
    const deduped = [...dedup.values()];
    this.logger.log(`EPG merge: ${allRaw.length} brut → ${deduped.length} dédupliqués (${unmatched.size} chaînes non mappées)`);

    // Enrichissement metadata (TVmaze/Fanart.tv, gratuit) — limité aux
    // programmes prime 19-23h pour limiter le nombre d'appels API.
    const toEnrich = deduped.filter((p) => {
      const h = p.startsAt.getHours();
      return h >= 19 && h <= 23;
    }).slice(0, 50);
    const enrichMap = await this.metadata.enrichBatch(
      toEnrich.map((p) => ({ title: p.title, type: normalizeCategoryToType(p.categories), year: null })),
    );

    // Persistance par channelId
    const byChannel = new Map<string, typeof deduped>();
    for (const prog of deduped) {
      const list = byChannel.get(prog.channelIdInternal) ?? [];
      list.push(prog);
      byChannel.set(prog.channelIdInternal, list);
    }

    let stored = 0;
    for (const [channelId, programmes] of byChannel) {
      // Delete ancien EPG pour ces chaînes (évite doublons extra)
      await this.prisma.epgProgramme.deleteMany({ where: { channelId } }).catch(() => {});
      const rows = programmes.map((p) => {
        const key = `${p.title.trim().toLowerCase()}::`;
        const enriched = enrichMap.get(key) ?? enrichMap.get(`${p.title.trim().toLowerCase()}::`);
        const meta = enriched
          ? {
              source: enriched.source,
              externalId: enriched.externalId,
              posterUrl: enriched.posterUrl,
              backdropUrl: enriched.backdropUrl,
              trailerUrl: enriched.trailerUrl,
              genres: enriched.genres,
              year: enriched.year,
              voteAverage: enriched.voteAverage,
            }
          : null;
        const type = normalizeCategoryToType(p.categories);
        return {
          id: undefined as unknown as string, // cuid auto
          channelId,
          startsAt: p.startsAt,
          endsAt: p.endsAt,
          title: p.title,
          description: p.description,
          imageUrl: p.imageUrl ?? meta?.posterUrl ?? null,
          metadata: {
            categories: p.categories,
            type,
            source: p.metadataSource,
            enriched: meta,
          },
        };
      });
      // createMany par 500
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500).map((r) => ({
          channelId: r.channelId,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          title: r.title,
          description: r.description,
          imageUrl: r.imageUrl,
          metadata: r.metadata as unknown as object,
        }));
        await this.prisma.epgProgramme.createMany({ data: chunk }).catch(() => {});
        stored += chunk.length;
      }
    }

    const unmatchedSample = [...unmatched.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, count]) => `${id} (${count})`);

    return { providers: providerNames, totalPrograms: deduped.length, stored, unmatchedSample };
  }

  async getFeaturedAuto(limit = 5): Promise<
    Array<{
      channelId: string;
      channel: { id: string; name: string; logoUrl: string | null };
      programme: RawProgramme & { posterUrl?: string | null; backdropUrl?: string | null; trailerUrl?: string | null; type?: string | null; genres?: string[] | null; year?: number | null };
    }>
  > {
    const now = new Date();
    const start = new Date(now);
    start.setHours(20, 0, 0, 0);
    const end = new Date(now);
    end.setHours(22, 30, 0, 0);
    if (now > end) {
      start.setDate(start.getDate() + 1);
      end.setDate(end.getDate() + 1);
    }
    const programmes = await this.prisma.epgProgramme.findMany({
      where: { startsAt: { gte: start, lte: end }, channel: { isVisible: true } },
      orderBy: { startsAt: 'asc' },
      take: 200,
      include: { channel: { select: { id: true, name: true, logoKey: true } } },
    });
    const scored = programmes
      .map((p) => {
        const meta = p.metadata as unknown as { type?: string; enriched?: { backdropUrl?: string | null; posterUrl?: string | null; trailerUrl?: string | null; voteAverage?: number; genres?: string[]; year?: number | null }; tmdb?: { backdropUrl?: string | null; posterUrl?: string | null; voteAverage?: number } | null } | null;
        const vote = meta?.enriched?.voteAverage ?? 0;
        // Compat : anciens payloads TMDB encore présents en base tant que
        // l'import n'a pas tourné avec les nouvelles sources.
        const legacyVote = meta?.tmdb?.voteAverage ?? 0;
        const score = vote || legacyVote;
        const hasBackdrop = Boolean(meta?.enriched?.backdropUrl ?? meta?.tmdb?.backdropUrl ?? p.imageUrl);
        return {
          p,
          meta,
          score: score + (hasBackdrop ? 0.5 : 0) + (meta?.type === 'movie' ? 0.3 : 0),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    // Résout logoUrl
    const logoMap = new Map<string, string | null>();
    for (const { p } of scored) {
      const ch = (p as unknown as { channel: { logoKey: string | null } }).channel;
      // Résolution logo simple : si http garde, sinon /uploads/
      const key = ch.logoKey;
      let url: string | null = null;
      if (key) {
        if (/^https?:\/\//i.test(key)) url = key;
        else {
          const base = this.config.get<string>('PUBLIC_API_URL', 'http://localhost:4000').replace(/\/+$/, '');
          url = `${base}/uploads/${key}`;
        }
      }
      logoMap.set(p.channelId, url);
    }
    return scored.map(({ p, meta }) => {
      const ch = (p as unknown as { channel: { id: string; name: string } }).channel;
      return {
        channelId: p.channelId,
        channel: { id: ch.id, name: ch.name, logoUrl: logoMap.get(p.channelId) ?? null },
        programme: {
          channelId: p.channelId,
          id: p.id,
          startsAt: p.startsAt,
          endsAt: p.endsAt,
          title: p.title,
          description: p.description,
          imageUrl: p.imageUrl,
          categories: ((meta as unknown as { categories?: string[] })?.categories ?? []) as string[],
          metadataSource: 'featured',
          type: (meta as unknown as { type?: string | null })?.type ?? null,
          posterUrl: meta?.enriched?.posterUrl ?? meta?.tmdb?.posterUrl ?? null,
          backdropUrl: meta?.enriched?.backdropUrl ?? meta?.tmdb?.backdropUrl ?? null,
          trailerUrl: meta?.enriched?.trailerUrl ?? null,
          genres: meta?.enriched?.genres ?? null,
          year: meta?.enriched?.year ?? null,
        } as unknown as RawProgramme & { posterUrl?: string | null; backdropUrl?: string | null; trailerUrl?: string | null; type?: string | null },
      };
    });
  }
}
