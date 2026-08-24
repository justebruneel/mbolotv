import { resolveLogoUrl } from "./channels.js";
import { loadHiddenIds } from "./categories.js";

const PLAYABLE_CHANNEL = `EXISTS (
  SELECT 1 FROM "StreamVariant" v JOIN "Source" s ON s.id = v."sourceId"
  WHERE v."channelId" = c.id AND v."isActive" AND (v."healthStatus" IS NULL OR v."healthStatus" = 'OK') AND s.status <> 'DISABLED'
)`;

async function hiddenFilter(env, startIndex) {
  const hiddenIds = await loadHiddenIds(env);
  if (hiddenIds.size === 0) return { sql: "", params: [] };
  return {
    sql: ` AND (c."categoryId" IS NULL OR c."categoryId" <> ALL($${startIndex}::text[]))`,
    params: [[...hiddenIds]],
  };
}

export async function searchProgrammes(env, query) {
  const params = [`%${query.q}%`];
  const hidden = await hiddenFilter(env, params.length + 1);
  params.push(...hidden.params);
  let categorySql = "";
  if (query.category) {
    params.push(query.category);
    categorySql = ` AND c."categoryId" IN (SELECT id FROM "Category" WHERE slug = $${params.length})`;
  }
  params.push(query.limit ?? 30);
  const result = await env.db.query(
    env,
    `SELECT p.id, p."channelId", p.title, p.description, p."imageUrl", p."startsAt", p."endsAt",
            c.id AS c_id, c.name AS c_name, c."canonicalName" AS c_canonical, c.country AS c_country, c."categoryId" AS c_category, c."logoKey" AS c_logo
     FROM "EpgProgramme" p JOIN "Channel" c ON c.id = p."channelId"
     WHERE p.title ILIKE $1 AND c."isVisible" = true AND ${PLAYABLE_CHANNEL}${hidden.sql}${categorySql}
     ORDER BY p."startsAt" DESC LIMIT $${params.length}`,
    params,
  );
  const items = result.rows.map((row) => ({
    id: row.id,
    channelId: row.channelId,
    title: row.title,
    description: row.description,
    imageUrl: row.imageUrl,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    channel: {
      id: row.c_id,
      name: row.c_name,
      canonicalName: row.c_canonical,
      country: row.c_country,
      categoryId: row.c_category,
      logoUrl: resolveLogoUrl(env, row.c_logo),
    },
  }));
  return { items, total: items.length };
}

export async function epgRange(env, query) {
  const to = query.to
    ? new Date(query.to)
    : new Date(Date.now() + 5 * 3_600_000);
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - 6 * 3_600_000);
  const params = [to, from];
  const hidden = await hiddenFilter(env, params.length + 1);
  params.push(...hidden.params);
  let categorySql = "";
  if (query.category) {
    params.push(query.category);
    categorySql = ` AND c."categoryId" IN (SELECT id FROM "Category" WHERE slug = $${params.length})`;
  }
  const result = await env.db.query(
    env,
    `SELECT p.id, p."channelId", p.title, p.description, p."imageUrl", p."startsAt", p."endsAt",
            c.id AS c_id, c.name AS c_name, c."canonicalName" AS c_canonical, c.country AS c_country, c."categoryId" AS c_category, c."logoKey" AS c_logo
     FROM "EpgProgramme" p JOIN "Channel" c ON c.id = p."channelId"
     WHERE p."startsAt" < $1 AND p."endsAt" > $2 AND c."isVisible" = true AND ${PLAYABLE_CHANNEL}${hidden.sql}${categorySql}
     ORDER BY c.id ASC, p."startsAt" ASC LIMIT 500`,
    params,
  );
  const programmesByChannel = new Map();
  for (const row of result.rows) {
    const list = programmesByChannel.get(row.channelId) ?? [];
    list.push({
      id: row.id,
      channelId: row.channelId,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      title: row.title,
      description: row.description,
      imageUrl: row.imageUrl,
    });
    programmesByChannel.set(row.channelId, list);
  }
  const items = [];
  for (const row of result.rows) {
    if (items.some((item) => item.channel.id === row.channelId)) continue;
    const list = programmesByChannel.get(row.channelId);
    if (!list) continue;
    items.push({
      channel: {
        id: row.c_id,
        name: row.c_name,
        canonicalName: row.c_canonical,
        country: row.c_country,
        categoryId: row.c_category,
        logoUrl: resolveLogoUrl(env, row.c_logo),
      },
      programmes: list,
    });
  }
  return { items, from: from.toISOString(), to: to.toISOString() };
}
