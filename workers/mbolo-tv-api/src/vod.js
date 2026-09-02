// Catalogue VOD (films + séries) : requêtes miroir de channels.js mais sur
// VodItem. Pas de health-check ni d'EPG : un fichier VOD n'a ni manifest
// #EXTM3U ni grille horaire. categoryTitle est du texte libre (pas la table
// Category — aucune collision avec les catégories live).
import { decryptLocatorWithSecret } from './crypto.js';
import { fetchXtreamSeriesInfo } from './xtream.js';

const SERIES_CACHE_TTL = "interval '1 hour'";

export const VISIBLE_VOD_ITEMS = `"isVisible" = true AND "isActive" = true`;

export function serializeVodItem(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    posterUrl: row.posterUrl,
    rating: row.rating,
    category: row.categoryTitle,
    addedAt: row.addedAt ? new Date(row.addedAt).toISOString() : null,
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

  const payload = {
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
