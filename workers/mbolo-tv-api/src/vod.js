// Catalogue VOD (films + séries) : requêtes miroir de channels.js mais sur
// VodItem. Pas de health-check ni d'EPG : un fichier VOD n'a ni manifest
// #EXTM3U ni grille horaire. categoryTitle est du texte libre (pas la table
// Category — aucune collision avec les catégories live).
import { decryptLocatorWithSecret } from './crypto.js';
import { fetchXtreamSeriesInfo } from './xtream.js';
import { vodMetadata } from './vodmetadata.js';
export { vodMetadata };

const SERIES_CACHE_TTL = "interval '1 hour'";

export const VISIBLE_VOD_ITEMS = `"isVisible" = true AND "isActive" = true`;

// La description ne vit pas en base : elle est enrichie à la volée
// (TVmaze, cache 30 j) sur les endpoints « riches » — hero et détail —
// tandis que les rangées/grilles restent légères (pas d'appel par tuile).
export function serializeVodItem(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    posterUrl: row.posterUrl,
    rating: row.rating,
    category: row.categoryTitle,
    addedAt: row.addedAt ? new Date(row.addedAt).toISOString() : null,
    ...(row.description !== undefined || row.backdropUrl !== undefined
      ? { description: row.description ?? null, backdropUrl: row.backdropUrl ?? null, genres: row.genres ?? [], year: row.year ?? null }
      : {}),
  };
}

export async function listVodItems(env, { kind, category, q, limit = 48, offset = 0 } = {}) {
  const params = [];
  const conditions = [VISIBLE_VOD_ITEMS];
  if (kind === 'MOVIE' || kind === 'SERIES') {
    params.push(kind);
    conditions.push(`kind = $${params.length}`);
  }
  if (category) {
    params.push(category);
    conditions.push(`"categoryTitle" = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`title ILIKE $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitParam = Math.min(Math.max(1, Number(limit) || 48), 100);
  const offsetParam = Math.max(0, Number(offset) || 0);

  const [rows, counts] = await Promise.all([
    env.db.query(
      env,
      `SELECT id, kind, title, "posterUrl", rating, "categoryTitle", "addedAt" FROM "VodItem" ${where}
       ORDER BY "addedAt" DESC NULLS LAST, title ASC LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    ),
    env.db.query(
      env,
      `SELECT COUNT(*)::int AS count FROM "VodItem" ${where}`,
      params,
    ),
  ]);
  const total = counts.rows[0]?.count ?? 0;
  return {
    items: rows.rows.map(serializeVodItem),
    total,
    hasMore: offsetParam + rows.rows.length < total,
  };
}

// Rangées « façon Netflix » : les N premières catégories d'un kind, chacune
// avec ses 20 titres les plus récents. Une seule requête SQL par rangée, en
// parallèle — la page d'accueil VOD charge tout en un aller-retour client.
export async function vodRows(env, { kind, rowsCount = 8, perRow = 20, q = null } = {}) {
  const rowsParam = Math.min(Math.max(1, Number(rowsCount) || 8), 20);
  const perParam = Math.min(Math.max(1, Number(perRow) || 20), 50);
  const params = [];
  const conditions = [VISIBLE_VOD_ITEMS];
  if (kind === 'MOVIE' || kind === 'SERIES') {
    params.push(kind);
    conditions.push(`kind = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`title ILIKE $${params.length}`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  // Top catégories par volume (catalogues Vivid/XTREAM : une catégorie = un
  // univers cohérent « SRS | FR - DRAME »), puis N titres récents chacune.
  const top = await env.db.query(
    env,
    `SELECT "categoryTitle" AS name, COUNT(*)::int AS count FROM "VodItem" ${where} AND "categoryTitle" IS NOT NULL
     GROUP BY "categoryTitle" ORDER BY count DESC, name ASC LIMIT ${rowsParam}`,
    params,
  );
  const categories = top.rows.filter((row) => row.name);
  const queries = categories.map((category) => {
    const rowParams = [...params, category.name];
    return env.db.query(
      env,
      `SELECT id, kind, title, "posterUrl", rating, "categoryTitle", "addedAt" FROM "VodItem"
       WHERE ${conditions.join(' AND ')} AND "categoryTitle" = $${rowParams.length}
       ORDER BY "addedAt" DESC NULLS LAST, title ASC LIMIT ${perParam}`,
      rowParams,
    );
  });
  // En avant-première : les tout derniers ajouts toutes catégories.
  const recent = env.db.query(
    env,
    `SELECT id, kind, title, "posterUrl", rating, "categoryTitle", "addedAt" FROM "VodItem" ${where}
     ORDER BY "addedAt" DESC NULLS LAST, title ASC LIMIT ${perParam}`,
    params,
  );
  const settled = await Promise.all([recent, ...queries]);
  const rows = [{ name: 'Nouveautés', count: null, items: settled[0].rows.map(serializeVodItem) }];
  categories.forEach((category, index) => {
    rows.push({ name: category.name, count: category.count, items: settled[index + 1].rows.map(serializeVodItem) });
  });
  return rows.filter((row) => row.items.length > 0);
}

// Héros plein écran : les derniers ajouts avec affiche (backdrop = poster
// agrandi, le fournisseur ne fournit que l'affiche 2:3).
export async function vodHero(env, { kind, limit = 5 } = {}) {
  const params = [];
  const conditions = [VISIBLE_VOD_ITEMS, '"posterUrl" IS NOT NULL'];
  if (kind === 'MOVIE' || kind === 'SERIES') {
    params.push(kind);
    conditions.push(`kind = $${params.length}`);
  }
  const rows = await env.db.query(
    env,
    `SELECT id, kind, title, "posterUrl", rating, "categoryTitle", "addedAt" FROM "VodItem"
     WHERE ${conditions.join(' AND ')} ORDER BY "addedAt" DESC NULLS LAST LIMIT ${Math.min(Math.max(1, Number(limit) || 5), 10)}`,
    params,
  );
  // Hero enrichi en parallèle (synopsis, backdrop, genres, année). Le
  // synopsis du fournisseur (description en base) reste prioritaire ;
  // TVmaze/TMDB ne comblent que les manques. Un échec ne retire jamais
  // l'item du hero.
  const metas = await Promise.all(rows.rows.map((row) => vodMetadata(env, row.title, row.kind).catch(() => null)));
  return rows.rows.map((row, index) => serializeVodItem({ ...(metas[index] ?? {}), ...row, description: row.description ?? metas[index]?.description ?? null, backdropUrl: metas[index]?.backdropUrl ?? null }));
}

export async function vodCategories(env, kind) {
  const params = [];
  let kindFilter = '';
  if (kind === 'MOVIE' || kind === 'SERIES') {
    params.push(kind);
    kindFilter = `WHERE kind = $1 AND "isActive" = true AND "isVisible" = true`;
  } else {
    kindFilter = `WHERE "isActive" = true AND "isVisible" = true`;
  }
  const rows = await env.db.query(
    env,
    `SELECT "categoryTitle" AS name, COUNT(*)::int AS count FROM "VodItem" ${kindFilter} AND "categoryTitle" IS NOT NULL GROUP BY "categoryTitle" ORDER BY count DESC, name ASC`,
    params,
  );
  return rows.rows.map((row) => ({ name: row.name, count: row.count }));
}

export async function findVodItemById(env, id) {
  const rows = await env.db.query(
    env,
    `SELECT id, kind, title, "normalizedKey", "posterUrl", rating, "categoryTitle", "containerExt", "addedAt", "sourceId", "encryptedLocator"
     FROM "VodItem" WHERE id = $1 AND "isActive" = true AND "isVisible" = true LIMIT 1`,
    [id],
  );
  return rows.rows[0] ?? null;
}

// ---- Dossiers administrés (console VOD → app) : miroir de vod.service.ts ---
// Un parent masqué exclut ses descendants (filtrage serveur, jamais client).

export async function visibleVodFolders(env, kind) {
  const folders = await env.db.query(
    env,
    `SELECT id, slug, name, kind, "parentId", "isVisible", "sortOrder" FROM "VodFolder" ORDER BY "sortOrder" ASC, name ASC`,
  );
  const byId = new Map(folders.rows.map((row) => [row.id, row]));
  const effective = new Map();
  const visiting = new Set();
  const compute = (id) => {
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
  folders.rows.forEach((row) => compute(row.id));
  return folders.rows.filter((row) => effective.get(row.id) && (!kind || row.kind === 'BOTH' || row.kind === kind));
}

async function folderItemWhere(env, slug, kind) {
  const folders = await visibleVodFolders(env);
  const folder = folders.find((row) => row.slug === slug);
  if (!folder) return null;
  const rules = await env.db.query(env, `SELECT "categoryKey" FROM "VodFolderRule" WHERE "folderId" = $1`, [folder.id]);
  const keys = rules.rows.map((row) => row.categoryKey);
  const params = [keys, folder.id];
  let filterKind = '';
  if (folder.kind !== 'BOTH') { params.push(folder.kind); filterKind = `AND kind = $${params.length}`; }
  else if (kind === 'MOVIE' || kind === 'SERIES') { params.push(kind); filterKind = `AND kind = $${params.length}`; }
  return { folder, sql: `("categoryKey" = ANY($1::text[]) OR EXISTS (SELECT 1 FROM "VodFolderItem" fi WHERE fi."vodItemId" = "VodItem".id AND fi."folderId" = $2)) ${filterKind}`, params };
}

export async function vodFolders(env, kind) {
  const visible = await visibleVodFolders(env, kind === 'MOVIE' || kind === 'SERIES' ? kind : undefined);
  const sources = visible.length > 0
    ? await env.db.query(
        env,
        `SELECT id, "folderId", "channelId", label FROM "VodYoutubeSource" WHERE "isActive" = true AND "folderId" = ANY($1::text[]) ORDER BY "sortOrder" ASC, "createdAt" ASC`,
        [visible.map((row) => row.id)],
      )
    : { rows: [] };
  const byFolder = new Map();
  for (const source of sources.rows) {
    const list = byFolder.get(source.folderId) ?? [];
    list.push({ id: source.id, channelId: source.channelId, label: source.label ?? null });
    byFolder.set(source.folderId, list);
  }
  return { folders: visible.map((row) => ({ id: row.id, slug: row.slug, name: row.name, kind: row.kind, parentId: row.parentId ?? null, youtubeSources: byFolder.get(row.id) ?? [] })) };
}

// Contenu d'un dossier : règles ∪ manuel (dédupé), les plus récents d'abord.
export async function vodFolderRows(env, slug, perRow = 20) {
  const scoped = await folderItemWhere(env, slug);
  if (!scoped) return null;
  const limit = Math.min(Math.max(1, Number(perRow) || 20), 50);
  const [rows, counts] = await Promise.all([
    env.db.query(
      env,
      `SELECT id, kind, title, "posterUrl", rating, "categoryTitle", "addedAt" FROM "VodItem"
       WHERE ${VISIBLE_VOD_ITEMS} AND ${scoped.sql}
       ORDER BY "addedAt" DESC NULLS LAST, title ASC LIMIT ${limit}`,
      scoped.params,
    ),
    env.db.query(env, `SELECT COUNT(*)::int AS count FROM "VodItem" WHERE ${VISIBLE_VOD_ITEMS} AND ${scoped.sql}`, scoped.params),
  ]);
  const sources = await env.db.query(
    env,
    `SELECT id, "channelId", label FROM "VodYoutubeSource" WHERE "folderId" = $1 AND "isActive" = true ORDER BY "sortOrder" ASC, "createdAt" ASC`,
    [scoped.folder.id],
  );
  const total = counts.rows[0]?.count ?? 0;
  return {
    folder: { id: scoped.folder.id, slug: scoped.folder.slug, name: scoped.folder.name, kind: scoped.folder.kind },
    youtubeSources: sources.rows.map((source) => ({ id: source.id, channelId: source.channelId, label: source.label ?? null })),
    items: rows.rows.map(serializeVodItem),
    total,
    hasMore: rows.rows.length < total,
  };
}

// « Parcourir tout » d'un dossier (pagination pleine).
export async function vodFolderItems(env, slug, { limit = 48, offset = 0, q } = {}) {
  const scoped = await folderItemWhere(env, slug);
  if (!scoped) return null;
  const params = [...scoped.params];
  let search = scoped.sql;
  if (q) { params.push(`%${q}%`); search += ` AND title ILIKE $${params.length}`; }
  const limitParam = Math.min(Math.max(1, Number(limit) || 48), 100);
  const offsetParam = Math.max(0, Number(offset) || 0);
  const [rows, counts] = await Promise.all([
    env.db.query(
      env,
      `SELECT id, kind, title, "posterUrl", rating, "categoryTitle", "addedAt" FROM "VodItem"
       WHERE ${VISIBLE_VOD_ITEMS} AND ${search}
       ORDER BY "addedAt" DESC NULLS LAST, title ASC LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    ),
    env.db.query(env, `SELECT COUNT(*)::int AS count FROM "VodItem" WHERE ${VISIBLE_VOD_ITEMS} AND ${search}`, params),
  ]);
  const total = counts.rows[0]?.count ?? 0;
  return { items: rows.rows.map(serializeVodItem), total, hasMore: offsetParam + rows.rows.length < total };
}

// Allowlist dynamique des chaînes YouTube (proxy /api/yt/*) : sources actives
// de dossiers effectivement visibles.
export async function vodYoutubeChannelIds(env) {
  const visible = await visibleVodFolders(env);
  if (visible.length === 0) return { channelIds: [] };
  const rows = await env.db.query(
    env,
    `SELECT DISTINCT "channelId" FROM "VodYoutubeSource" WHERE "isActive" = true AND "folderId" = ANY($1::text[])`,
    [visible.map((row) => row.id)],
  );
  return { channelIds: rows.rows.map((row) => row.channelId) };
}

// Favoris VOD : deviceId du header x-device-id, miroir de favorites.js.
export async function listVodFavorites(env, deviceId) {
  const rows = await env.db.query(
    env,
    `SELECT v.id, v.kind, v.title, v."posterUrl", v.rating, v."categoryTitle", v."addedAt"
     FROM "VodFavorite" f JOIN "VodItem" v ON v.id = f."vodItemId"
     WHERE f."deviceId" = $1 AND v."isActive" = true AND v."isVisible" = true
     ORDER BY f."createdAt" DESC`,
    [deviceId],
  );
  return rows.rows.map(serializeVodItem);
}

export async function addVodFavorite(env, deviceId, vodItemId) {
  const item = await findVodItemById(env, vodItemId);
  if (!item) return false;
  await env.db.query(
    env,
    `INSERT INTO "VodFavorite" ("deviceId", "vodItemId") VALUES ($1, $2) ON CONFLICT ("deviceId", "vodItemId") DO NOTHING`,
    [deviceId, vodItemId],
  );
  return true;
}

export async function removeVodFavorite(env, deviceId, vodItemId) {
  await env.db.query(
    env,
    `DELETE FROM "VodFavorite" WHERE "deviceId" = $1 AND "vodItemId" = $2`,
    [deviceId, vodItemId],
  );
}

// ---- Résolution lecture ---------------------------------------------------

// Épisodes d'une série : get_series_info (1 requête fournisseur) mis en cache
// dans MetadataCache (TTL 1 h) — la fiche série et le play d'un épisode
// partagent le même cache.
export async function listSeriesEpisodes(env, encryptionKey, item) {
  const cacheKey = `vod-series-episodes-${item.id}`;
  const cached = await env.db.query(
    env,
    `SELECT payload FROM "MetadataCache" WHERE "cacheKey" = $1 AND "expiresAt" > now() LIMIT 1`,
    [cacheKey],
  );
  if (cached.rows.length > 0) return cached.rows[0].payload;

  const connection = JSON.parse(await decryptLocatorWithSecret(encryptionKey, item.encryptedLocator));
  if (connection.type !== 'xtream-series') throw new Error('Locator série invalide');
  const info = await fetchXtreamSeriesInfo(env, connection, connection.seriesId);

  const meta = await vodMetadata(env, item.title, 'SERIES').catch(() => null);
  const payload = {
    description: item.description ?? meta?.description ?? null,
    backdropUrl: meta?.backdropUrl ?? null,
    genres: meta?.genres ?? [],
    year: meta?.year ?? null,
    seasons: info.seasons.map((season) => ({
      number: season.number,
      episodes: season.episodes.map((episode) => ({
        id: episode.id,
        num: episode.num,
        title: episode.title,
        containerExt: episode.containerExt,
      })),
    })),
  };
  await env.db.query(
    env,
    `INSERT INTO "MetadataCache" (id, "cacheKey", title, payload, "expiresAt")
     VALUES ($1, $2, $3, $4, now() + ${SERIES_CACHE_TTL})
     ON CONFLICT ("cacheKey") DO UPDATE SET payload = EXCLUDED.payload, "expiresAt" = EXCLUDED."expiresAt"`,
    [crypto.randomUUID(), cacheKey, item.title, JSON.stringify(payload)],
  ).catch(() => undefined);
  return payload;
}

// URL de lecture directe du fournisseur pour un item VOD :
//   film   → locator (URL /movie/...) telle quelle ;
//   série  → {base}/series/{user}/{pass}/{episode_id}.{ext} via le locator
//            JSON + l'épisode demandé (params s/e).
// La signature proxy (direct=1) est ajoutée par playResponse côté route.
export async function resolveVodProviderUrl(env, encryptionKey, item, { season, episode } = {}) {
  if (item.kind === 'MOVIE') return decryptLocatorWithSecret(encryptionKey, item.encryptedLocator);
  if (item.kind !== 'SERIES') return null;
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return null;

  const series = await listSeriesEpisodes(env, encryptionKey, item);
  const seasonData = series.seasons.find((entry) => entry.number === season);
  const episodeData = seasonData?.episodes.find((entry) => entry.num === episode)
    ?? seasonData?.episodes.find((entry) => entry.id === String(episode));
  if (!episodeData) return null;

  const connection = JSON.parse(await decryptLocatorWithSecret(encryptionKey, item.encryptedLocator));
  if (connection.type !== 'xtream-series') return null;
  const base = connection.base.replace(/\/+$/, '');
  const ext = episodeData.containerExt || 'mp4';
  return `${base}/series/${encodeURIComponent(connection.username)}/${encodeURIComponent(connection.password)}/${episodeData.id}.${ext}`;
}
