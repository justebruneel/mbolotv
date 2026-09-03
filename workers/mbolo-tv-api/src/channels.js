import { loadHiddenIds, categoryFilterSql } from "./categories.js";

export const VISIBLE_VARIANTS =
  'EXISTS (SELECT 1 FROM "StreamVariant" v WHERE v."channelId" = c.id AND v."isActive" AND (v."healthStatus" IS NULL OR v."healthStatus" = \'OK\'))';

export function resolveLogoUrl(env, logoKey) {
  if (!logoKey) return null;
  if (/^https?:\/\//i.test(logoKey)) {
    // URL fournisseur servie via le proxy /api/logo (l'hôte d'origine est
    // souvent mort/bloqué/mixed-content). L'URL brute est conservée telle
    // quelle : la route vérifie son existence en base (allowlist) et monte
    // en https au moment du fetch.
    const base = (env.PUBLIC_API_URL ?? "").replace(/\/+$/, "");
    if (!base) return logoKey;
    return `${base}/api/logo?url=${encodeURIComponent(logoKey)}`;
  }
  const base = (env.PUBLIC_API_URL ?? "").replace(/\/+$/, "");
  return base ? `${base}/uploads/${logoKey}` : null;
}

export async function nowPlayingByChannel(env, channelIds) {
  const map = new Map();
  if (channelIds.length === 0) return map;
  const result = await env.db.query(
    env,
    `SELECT DISTINCT ON ("channelId") "channelId", "startsAt", "endsAt", title, "imageUrl"
     FROM "EpgProgramme" WHERE "channelId" = ANY($1::text[]) AND "startsAt" <= now() AND "endsAt" > now()`,
    [channelIds],
  );
  for (const row of result.rows) {
    map.set(row.channelId, {
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      title: row.title,
      imageUrl: row.imageUrl ?? null,
    });
  }
  return map;
}

export async function healthByChannel(env, channelIds) {
  const map = new Map();
  if (channelIds.length === 0) return map;
  const result = await env.db.query(
    env,
    `SELECT "channelId", "healthStatus" FROM "StreamVariant"
     WHERE "channelId" = ANY($1::text[]) AND "isActive" AND "healthStatus" IS NOT NULL`,
    [channelIds],
  );
  for (const row of result.rows) {
    if (!map.has(row.channelId) || row.healthStatus === "OK")
      map.set(row.channelId, row.healthStatus);
  }
  return map;
}

export function serialize(env, row, nowPlaying, healthStatus) {
  return {
    id: row.id,
    name: row.name,
    canonicalName: row.canonicalName,
    country: row.country,
    categoryId: row.categoryId,
    logoUrl: resolveLogoUrl(env, row.logoKey),
    healthStatus,
    ...(nowPlaying !== undefined ? { nowPlaying } : {}),
  };
}

export async function listChannels(env, query) {
  const hiddenIds = await loadHiddenIds(env);
  const category = categoryFilterSql(hiddenIds, query.category);
  const baseParams = [...category.params];
  let filters = "";
  if (query.country) {
    baseParams.push(query.country);
    filters += ` AND c.country = $${baseParams.length}`;
  }
  if (query.q) {
    baseParams.push(`%${query.q}%`);
    filters += ` AND (c."canonicalName" ILIKE $${baseParams.length} OR c.name ILIKE $${baseParams.length} OR c.country ILIKE $${baseParams.length})`;
  }
  const where = `c."isVisible" = true${category.sql}${filters} AND ${VISIBLE_VARIANTS}`;
  const [rows, count] = await Promise.all([
    env.db.query(
      env,
      `SELECT c.id, c.name, c."canonicalName", c.country, c."categoryId", c."logoKey" FROM "Channel" c WHERE ${where} ORDER BY c."sortOrder" ASC, c."canonicalName" ASC LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`,
      [...baseParams, query.limit ?? 48, query.offset ?? 0],
    ),
    env.db.query(
      env,
      `SELECT COUNT(*)::int AS total FROM "Channel" c WHERE ${where}`,
      baseParams,
    ),
  ]);
  const ids = rows.rows.map((row) => row.id);
  const [nowPlaying, health] = await Promise.all([
    nowPlayingByChannel(env, ids),
    healthByChannel(env, ids),
  ]);
  const items = rows.rows.map((row) =>
    serialize(
      env,
      row,
      nowPlaying.get(row.id) ?? null,
      health.get(row.id) ?? null,
    ),
  );
  return {
    items,
    total: count.rows[0].total,
    hasMore: (query.offset ?? 0) + items.length < count.rows[0].total,
  };
}

export async function countries(env) {
  const hiddenIds = await loadHiddenIds(env);
  const category = categoryFilterSql(hiddenIds, null);
  const result = await env.db.query(
    env,
    `SELECT c.country, COUNT(*)::int AS count FROM "Channel" c
     WHERE c."isVisible" = true AND c.country IS NOT NULL${category.sql} AND ${VISIBLE_VARIANTS}
     GROUP BY c.country ORDER BY count DESC`,
    category.params,
  );
  return result.rows.map((row) => ({
    slug: row.country,
    name: row.country,
    count: row.count,
  }));
}

async function findVisibleChannel(env, id, requirePlayable) {
  const hiddenIds = await loadHiddenIds(env);
  const category = categoryFilterSql(hiddenIds, null, 'c', 2);
  const playable = requirePlayable ? ` AND ${VISIBLE_VARIANTS}` : "";
  const result = await env.db.query(
    env,
    `SELECT c.* FROM "Channel" c WHERE c.id = $1 AND c."isVisible" = true${playable}${category.sql}`,
    [id, ...category.params],
  );
  return result.rows[0] ?? null;
}

export async function findChannelById(env, id) {
  const channel = await findVisibleChannel(env, id, true);
  if (!channel) return null;
  const [nowPlaying, health] = await Promise.all([
    nowPlayingByChannel(env, [id]),
    healthByChannel(env, [id]),
  ]);
  return serialize(
    env,
    channel,
    nowPlaying.get(id) ?? null,
    health.get(id) ?? null,
  );
}

export async function channelEpg(env, id) {
  const channel = await findVisibleChannel(env, id, false);
  if (!channel) return null;
  const from = new Date(Date.now() - 3 * 3_600_000);
  const to = new Date(Date.now() + 12 * 3_600_000);
  const result = await env.db.query(
    env,
    `SELECT id, "channelId", "startsAt", "endsAt", title, description, "imageUrl"
     FROM "EpgProgramme" WHERE "channelId" = $1 AND "startsAt" <= $2 AND "endsAt" >= $3 ORDER BY "startsAt" ASC`,
    [id, to, from],
  );
  return result.rows.map((row) => ({
    id: row.id,
    channelId: row.channelId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    title: row.title,
    description: row.description,
    imageUrl: row.imageUrl,
  }));
}
