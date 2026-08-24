import { resolveLogoUrl } from "./channels.js";

export function serializeMatch(env, match, variants) {
  const byChannel = new Map();
  for (const variant of variants) {
    if (!variant.is_active || variant.source_status === "DISABLED") continue;
    const entry = byChannel.get(variant.channel_id);
    if (entry) {
      entry.streamCount += 1;
      entry.bestHealth = Math.max(
        entry.bestHealth ?? 0,
        Number(variant.health_score),
      );
    } else {
      byChannel.set(variant.channel_id, {
        id: variant.channel_id,
        name: variant.channel_name,
        logoUrl: resolveLogoUrl(env, variant.channel_logo_key),
        streamCount: 1,
        bestHealth: Number(variant.health_score),
      });
    }
  }
  return {
    id: match.id,
    sport: match.sport,
    competition: match.competition,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    startsAt: match.startsAt.toISOString(),
    endsAt: match.endsAt ? match.endsAt.toISOString() : null,
    state: match.state,
    channels: [...byChannel.values()],
  };
}

export async function listMatches(env, query) {
  const params = [];
  const filters = [];
  if (query.state) {
    params.push(query.state);
    filters.push(`m.state = $${params.length}`);
  }
  if (query.sport) {
    params.push(query.sport);
    filters.push(`m.sport = $${params.length}`);
  }
  if (query.from) {
    params.push(query.from);
    filters.push(`m."startsAt" >= $${params.length}`);
  }
  if (query.to) {
    params.push(query.to);
    filters.push(`m."startsAt" <= $${params.length}`);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const matches = await env.db.query(
    env,
    `SELECT * FROM "Match" m ${where} ORDER BY m."startsAt" ASC LIMIT 200`,
    params,
  );
  if (matches.rows.length === 0) return { items: [], total: 0 };
  const variants = await env.db.query(
    env,
    `SELECT ms."matchId", v."isActive", v."healthScore", s.status AS source_status,
            c.id AS channel_id, c.name AS channel_name, c."logoKey" AS channel_logo_key
     FROM "MatchStream" ms
     JOIN "StreamVariant" v ON v.id = ms."streamVariantId"
     JOIN "Channel" c ON c.id = v."channelId"
     JOIN "Source" s ON s.id = v."sourceId"
     WHERE ms."matchId" = ANY($1::text[])`,
    [matches.rows.map((row) => row.id)],
  );
  const byMatch = new Map();
  for (const variant of variants.rows) {
    const list = byMatch.get(variant.matchId) ?? [];
    list.push(variant);
    byMatch.set(variant.matchId, list);
  }
  const items = matches.rows.map((row) =>
    serializeMatch(env, row, byMatch.get(row.id) ?? []),
  );
  return { items, total: items.length };
}

export async function findMatchVariants(env, id) {
  const match = await env.db.query(env, `SELECT * FROM "Match" WHERE id = $1`, [
    id,
  ]);
  if (match.rows.length === 0) return null;
  const variants = await env.db.query(
    env,
    `SELECT v.id, v."encryptedLocator", v."healthScore", v."healthStatus", v."isActive",
            s.status AS source_status, s.priority AS source_priority, c.id AS channel_id
     FROM "MatchStream" ms
     JOIN "StreamVariant" v ON v.id = ms."streamVariantId"
     JOIN "Source" s ON s.id = v."sourceId"
     JOIN "Channel" c ON c.id = v."channelId"
     WHERE ms."matchId" = $1
     ORDER BY v."healthScore" DESC, s.priority ASC`,
    [id],
  );
  return { match: match.rows[0], variants: variants.rows };
}
