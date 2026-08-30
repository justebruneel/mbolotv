import { loadHiddenIds, categoryFilterSql } from "./categories.js";
import { serialize, nowPlayingByChannel, healthByChannel, VISIBLE_VARIANTS } from "./channels.js";

/**
 * Favoris par appareil (x-device-id), miroir de l'implémentation NestJS :
 * liste sérialisée comme /channels (logo, DIRECT, santé), les plus récemment
 * ajoutés d'abord ; ajouts/retraits idempotents.
 */
export async function listFavorites(env, deviceId) {
  const favorites = await env.db.query(
    env,
    `SELECT "channelId" FROM "Favorite" WHERE "deviceId" = $1 ORDER BY "createdAt" DESC`,
    [deviceId],
  );
  const ids = favorites.rows.map((row) => row.channelId);
  if (ids.length === 0) return { items: [], total: 0, hasMore: false };
  const hiddenIds = await loadHiddenIds(env);
  const category = categoryFilterSql(hiddenIds, null, "c", 2);
  const rows = await env.db.query(
    env,
    `SELECT c.id, c.name, c."canonicalName", c.country, c."categoryId", c."logoKey"
     FROM "Channel" c
     WHERE c.id = ANY($1::text[]) AND c."isVisible" = true${category.sql} AND ${VISIBLE_VARIANTS}`,
    [ids, ...category.params],
  );
  const channelIds = rows.rows.map((row) => row.id);
  const nowPlaying = await nowPlayingByChannel(env, channelIds);
  const health = await healthByChannel(env, channelIds);
  const items = rows.rows.map((row) =>
    serialize(env, row, nowPlaying.get(row.id) ?? null, health.get(row.id) ?? null),
  );
  // Les chaînes devenues invisibles disparaissent ; l'ordre suit la récence
  // des favoris (celle de la table Favorite).
  const order = new Map(ids.map((id, index) => [id, index]));
  items.sort((a, b) => order.get(a.id) - order.get(b.id));
  return { items, total: items.length, hasMore: false };
}

export async function addFavorite(env, deviceId, channelId) {
  const exists = await env.db.query(env, `SELECT 1 FROM "Channel" WHERE id = $1 LIMIT 1`, [channelId]);
  if (exists.rows.length === 0) return null;
  await env.db.query(
    env,
    `INSERT INTO "Favorite" ("deviceId", "channelId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [deviceId, channelId],
  );
  return { ok: true };
}

export async function removeFavorite(env, deviceId, channelId) {
  await env.db.query(
    env,
    `DELETE FROM "Favorite" WHERE "deviceId" = $1 AND "channelId" = $2`,
    [deviceId, channelId],
  );
  return { ok: true };
}
