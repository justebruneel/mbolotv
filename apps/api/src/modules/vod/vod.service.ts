import { Injectable, NotFoundException } from '@nestjs/common';
import type { VodCategory, VodFolderKind, VodFolderRowsResponse, VodFolderSummary, VodHeroResponse, VodItem, VodKind, VodListResponse, VodRowsResponse, VodYoutubeSourcePublic } from '@mbolo/contracts';
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

  // Synopsis fournisseur en priorité ; TVmaze/TMDB ne comblent que les
  // manques (backdrop, genres, année) — miroir du Worker (vodmetadata.js).
  private async enrich(title: string, providerDescription?: string | null): Promise<{ description: string | null; backdropUrl: string | null; genres: string[]; year: number | null }> {
    try {
      const meta = await this.metadata.enrich(title);
      return {
        description: providerDescription ?? meta?.overview ?? null,
        backdropUrl: meta?.backdropUrl ?? null,
        genres: meta?.genres ?? [],
        year: meta?.year ?? null,
      };
    } catch {
      return { description: providerDescription ?? null, backdropUrl: null, genres: [], year: null };
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
    const metas = await Promise.all(rows.map((row) => this.enrich(row.title, row.description)));
    return { items: rows.map((row, index) => ({ ...serializeVodItem(row), ...metas[index] })) };
  }

  // ---- Dossiers administrés (console propriétaire → app) ----
  // Miroir de workers/mbolo-tv-api/src/vod.js : folders/rows/items + allowlist
  // YouTube dynamique. Un parent masqué exclut ses descendants (filtrage
  // serveur, jamais client).
  private async visibleFolders(kind?: VodKind): Promise<Array<{ id: string; slug: string; name: string; kind: string; parentId: string | null; sortOrder: number }>> {
    const rows = await this.prisma.vodFolder.findMany({ select: { id: true, slug: true, name: true, kind: true, parentId: true, isVisible: true, sortOrder: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    const effective = new Map<string, boolean>();
    const visiting = new Set<string>();
    const compute = (id: string): boolean => {
      const cached = effective.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) { effective.set(id, false); return false; }
      visiting.add(id);
      const node = byId.get(id);
      const result = !!node && node.isVisible && (node.parentId == null || !byId.has(node.parentId) || compute(node.parentId));
      visiting.delete(id);
      effective.set(id, result);
      return result;
    };
    rows.forEach((row) => compute(row.id));
    return rows.filter((row) => effective.get(row.id) && (!kind || row.kind === 'BOTH' || row.kind === kind));
  }

  async folders(kind?: VodKind): Promise<{ folders: VodFolderSummary[] }> {
    const visible = await this.visibleFolders(kind);
    const sources = await this.prisma.vodYoutubeSource.findMany({ where: { isActive: true, folderId: { in: visible.map((row) => row.id) } }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    const byFolder = new Map<string, VodYoutubeSourcePublic[]>();
    for (const source of sources) { const list = byFolder.get(source.folderId) ?? []; list.push({ id: source.id, channelId: source.channelId, label: source.label }); byFolder.set(source.folderId, list); }
    return { folders: visible.map((row) => ({ id: row.id, slug: row.slug, name: row.name, kind: row.kind as VodFolderKind, parentId: row.parentId, youtubeSources: byFolder.get(row.id) ?? [] })) };
  }

  // Contenu d'un dossier : items apportés par les règles ∪ affectations
  // manuelles (dédupés), les plus récents d'abord. Les vidéos YouTube ne
  // transitent pas par ici — l'app les tire de YouTube comme avant.
  async folderRows(slug: string, perRow = 20): Promise<VodFolderRowsResponse> {
    const safePerRow = Math.min(Math.max(1, Number(perRow) || 20), 50);
    const { folder, where } = await this.folderItemWhere(slug);
    const [rows, total] = await Promise.all([
      this.prisma.vodItem.findMany({ where, orderBy: [{ addedAt: 'desc' }, { title: 'asc' }], take: safePerRow }),
      this.prisma.vodItem.count({ where }),
    ]);
    const sources = await this.prisma.vodYoutubeSource.findMany({ where: { folderId: folder.id, isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return {
      folder: { id: folder.id, slug: folder.slug, name: folder.name, kind: folder.kind as VodFolderKind },
      youtubeSources: sources.map((source) => ({ id: source.id, channelId: source.channelId, label: source.label })),
      items: rows.map(serializeVodItem),
      total,
      hasMore: rows.length < total,
    };
  }

  // « Parcourir tout » d'un dossier (pagination pleine).
  async folderItems(slug: string, { limit = 48, offset = 0, q }: { limit?: number; offset?: number; q?: string } = {}): Promise<VodListResponse> {
    const safeLimit = Math.min(Math.max(1, Number(limit) || 48), 100);
    const safeOffset = Math.max(0, Number(offset) || 0);
    const { where: base } = await this.folderItemWhere(slug);
    const where = { ...base, ...(q ? { title: { contains: q } } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.vodItem.findMany({ where, orderBy: [{ addedAt: 'desc' }, { title: 'asc' }], take: safeLimit, skip: safeOffset }),
      this.prisma.vodItem.count({ where }),
    ]);
    return { items: rows.map(serializeVodItem), total, hasMore: safeOffset + rows.length < total };
  }

  // Allowlist dynamique des chaînes YouTube (proxy /api/yt/*) : seules les
  // sources actives d'un dossier effectivement visible sont interrogées.
  async youtubeChannels(): Promise<{ channelIds: string[] }> {
    const visible = await this.visibleFolders();
    const rows = await this.prisma.vodYoutubeSource.findMany({ where: { isActive: true, folderId: { in: visible.map((row) => row.id) } }, select: { channelId: true }, distinct: ['channelId'] });
    return { channelIds: rows.map((row) => row.channelId) };
  }

  private async folderItemWhere(slug: string): Promise<{ folder: { id: string; slug: string; name: string; kind: string }; where: Record<string, unknown> }> {
    const folders = await this.visibleFolders();
    const folder = folders.find((row) => row.slug === slug);
    if (!folder) throw new NotFoundException('Dossier introuvable');
    const keys = (await this.prisma.vodFolderRule.findMany({ where: { folderId: folder.id }, select: { categoryKey: true } })).map((rule) => rule.categoryKey);
    const or: unknown[] = [{ folders: { some: { folderId: folder.id } } }];
    if (keys.length > 0) or.push({ categoryKey: { in: keys } });
    return {
      folder,
      where: { ...VISIBLE, OR: or, ...(folder.kind === 'BOTH' ? {} : { kind: folder.kind }) },
    };
  }

  async detail(id: string): Promise<VodItem & { containerExt: string | null }> {
    const row = await this.prisma.vodItem.findFirst({ where: { id, ...VISIBLE } });
    if (!row) throw new NotFoundException('VodItem introuvable');
    const meta = await this.enrich(row.title, row.description);
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
