import { Injectable, NotFoundException } from '@nestjs/common';
import type { VodCategory, VodHeroResponse, VodItem, VodKind, VodListResponse, VodRowsResponse } from '@mbolo/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { MetadataService } from '../metadata/metadata.service';

// Catalogue VOD (films + séries) : miroir exact de workers/mbolo-tv-api/src/
// vod.js sur Prisma. Les items actifs et visibles seuls sont exposés.
// categoryTitle est du texte libre (pas la table Category — aucune collision
// avec les catégories live).
type PrismaLikeRow = {
  id: string;
  kind: string;
  title: string;
  posterUrl: string | null;
  rating: number | null;
  categoryTitle: string | null;
  addedAt: Date | null;
};

function serializeVodItem(row: PrismaLikeRow): VodItem {
  return {
    id: row.id,
    kind: row.kind as VodItem['kind'],
    title: row.title,
    posterUrl: row.posterUrl,
    rating: row.rating,
    category: row.categoryTitle,
    addedAt: row.addedAt ? row.addedAt.toISOString() : null,
  };
}

const VISIBLE = { isActive: true, isVisible: true } as const;

@Injectable()
export class VodService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly metadata: MetadataService) {}

  // Synopsis + backdrop via l'enrichissement TVmaze (cache 30 j) — miroir du
  // Worker (vodmetadata.js). Jamais bloquant : null si pas de correspondance.
  private async enrich(title: string): Promise<{ description: string | null; backdropUrl: string | null; genres: string[]; year: number | null }> {
    try {
      const meta = await this.metadata.enrich(title);
      return { description: meta?.overview ?? null, backdropUrl: meta?.backdropUrl ?? null, genres: meta?.genres ?? [], year: meta?.year ?? null };
    } catch {
      return { description: null, backdropUrl: null, genres: [], year: null };
    }
  }

  async list({ kind, category, q, limit = 48, offset = 0 }: { kind?: VodKind; category?: string; q?: string; limit?: number; offset?: number }): Promise<VodListResponse> {
    const safeLimit = Math.min(Math.max(1, Number(limit) || 48), 100);
    const safeOffset = Math.max(0, Number(offset) || 0);
    const where = { ...VISIBLE, ...(kind ? { kind } : {}), ...(category ? { categoryTitle: category } : {}), ...(q ? { title: { contains: q } } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.vodItem.findMany({ where, orderBy: [{ addedAt: 'desc' }, { title: 'asc' }], take: safeLimit, skip: safeOffset }),
      this.prisma.vodItem.count({ where }),
    ]);
    return { items: rows.map(serializeVodItem), total, hasMore: safeOffset + rows.length < total };
  }

  async categories(kind?: VodKind): Promise<VodCategory[]> {
    const rows = await this.prisma.vodItem.groupBy({
      by: ['categoryTitle'],
      where: { ...VISIBLE, ...(kind ? { kind } : {}), categoryTitle: { not: null } },
      _count: { categoryTitle: true },
      orderBy: { _count: { categoryTitle: 'desc' } },
    });
    return rows
      .filter((row) => row.categoryTitle)
      .map((row) => ({ name: row.categoryTitle as string, count: row._count.categoryTitle }));
  }

  // Accueil façon Netflix : top catégories × N titres récents, en parallèle
  // (Promise.all), plus la rangée « Nouveautés » toutes catégories.
  async rows({ kind, rowsCount = 8, perRow = 20, q }: { kind?: VodKind; rowsCount?: number; perRow?: number; q?: string }): Promise<VodRowsResponse> {
    const safeRows = Math.min(Math.max(1, Number(rowsCount) || 8), 20);
    const safePerRow = Math.min(Math.max(1, Number(perRow) || 20), 50);
    const where = { ...VISIBLE, ...(kind ? { kind } : {}), ...(q ? { title: { contains: q } } : {}) };
    const top = await this.prisma.vodItem.groupBy({
      by: ['categoryTitle'],
      where: { ...where, categoryTitle: { not: null } },
      _count: { categoryTitle: true },
      orderBy: { _count: { categoryTitle: 'desc' } },
      take: safeRows,
    });
    const categories = top.map((row) => row.categoryTitle).filter((name): name is string => Boolean(name));
    const [recent, ...perCategory] = await Promise.all([
      this.prisma.vodItem.findMany({ where: { ...where, posterUrl: { not: null } }, orderBy: [{ addedAt: 'desc' }, { title: 'asc' }], take: safePerRow }),
      ...categories.map((name) =>
        this.prisma.vodItem.findMany({ where: { ...where, categoryTitle: name }, orderBy: [{ addedAt: 'desc' }, { title: 'asc' }], take: safePerRow }),
      ),
    ]);
    const rows: VodRowsResponse['rows'] = [{ name: 'Nouveautés', count: null, items: recent.map(serializeVodItem) }];
    categories.forEach((name, index) => {
      rows.push({ name, count: top.find((row) => row.categoryTitle === name)?._count.categoryTitle ?? null, items: perCategory[index].map(serializeVodItem) });
    });
    return { rows: rows.filter((row) => row.items.length > 0) };
  }

  async hero(kind?: VodKind): Promise<VodHeroResponse> {
    const rows = await this.prisma.vodItem.findMany({
      where: { ...VISIBLE, ...(kind ? { kind } : {}), posterUrl: { not: null } },
      orderBy: [{ addedAt: 'desc' }, { title: 'asc' }],
      take: 5,
    });
    const metas = await Promise.all(rows.map((row) => this.enrich(row.title)));
    return { items: rows.map((row, index) => ({ ...serializeVodItem(row), ...metas[index] })) };
  }

  async detail(id: string): Promise<VodItem & { containerExt: string | null }> {
    const row = await this.prisma.vodItem.findFirst({ where: { id, ...VISIBLE } });
    if (!row) throw new NotFoundException('VodItem introuvable');
    const meta = await this.enrich(row.title);
    return { ...serializeVodItem(row), ...meta, containerExt: row.containerExt };
  }

  // Épisodes d'une série : déchiffre le locator (JSON xtream-series) et
  // interroge le panel get_series_info avec un cache TTL 1 h côté MetadataCache.
  async episodes(id: string): Promise<{ seasons: Array<{ number: number; episodes: Array<{ id: string; num: number; title: string | null; containerExt: string }> }> }> {
    const row = await this.prisma.vodItem.findFirst({ where: { id, kind: 'SERIES', ...VISIBLE } });
    if (!row) throw new NotFoundException('Série introuvable');
    const cacheKey = `vod-series-episodes-${row.id}`;
    const cached = await this.prisma.metadataCache.findFirst({ where: { cacheKey, expiresAt: { gt: new Date() } } });
    if (cached) return cached.payload as ReturnType<typeof JSON.parse>;

    const connection = JSON.parse(this.crypto.decrypt(row.encryptedLocator)) as { type?: string; base?: string; username?: string; password?: string; seriesId?: string };
    if (connection.type !== 'xtream-series' || !connection.base || !connection.username || !connection.password || !connection.seriesId) throw new NotFoundException('Locator série invalide');
    const base = connection.base.replace(/\/+$/, '');
    const url = `${base}/player_api.php?username=${encodeURIComponent(connection.username)}&password=${encodeURIComponent(connection.password)}&action=get_series_info&series_id=${encodeURIComponent(connection.seriesId)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
    if (!response.ok) throw new NotFoundException('Panel fournisseur indisponible');
    const payload = (await response.json()) as { seasons?: Array<{ season?: number | string }>; episodes?: Record<string, Array<{ id?: number | string; episode_num?: number | string; title?: string; container_extension?: string }>> };
    const numbers = new Set<number>();
    for (const season of Array.isArray(payload.seasons) ? payload.seasons : []) {
      const value = Number(season.season);
      if (Number.isFinite(value)) numbers.add(value);
    }
    for (const key of Object.keys(payload.episodes ?? {})) if (/^\d+$/.test(key)) numbers.add(Number(key));
    const seasons = [...numbers].sort((a, b) => a - b).map((number) => ({
      number,
      episodes: (payload.episodes?.[String(number)] ?? [])
        .filter((episode) => episode?.id != null)
        .map((episode) => ({
          id: String(episode.id),
          num: Number(episode.episode_num ?? 0) || 0,
          title: episode.title != null ? String(episode.title).trim() : null,
          containerExt: String(episode.container_extension ?? 'mp4').trim().replace(/^\./, '') || 'mp4',
        }))
        .sort((a, b) => a.num - b.num),
    }));
    const meta = await this.enrich(row.title);
    const result = { ...meta, seasons };
    await this.prisma.metadataCache
      .upsert({
        where: { cacheKey },
        create: { cacheKey, title: row.title, payload: result, expiresAt: new Date(Date.now() + 3600_000) },
        update: { payload: result, expiresAt: new Date(Date.now() + 3600_000) },
      })
      .catch(() => undefined);
    return result;
  }
}
