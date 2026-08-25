import { sha256Hex } from "./crypto.js";
import { loadHiddenIds, categoryFilterSql } from "./categories.js";

// Sélection identique à StreamingService.createPlay / MatchesService.play :
// variantes actives de sources non DISABLED, tri healthScore desc puis priority asc,
// première variante non DOWN préférée.
export async function selectVariant(env, channelId, filterChannelId) {
  const params = [channelId];
  let channelFilter = 'v."channelId" = $1';
  if (filterChannelId) {
    params.push(filterChannelId);
    channelFilter += ` AND c.id = $${params.length}`;
  }
  const result = await env.db.query(
    env,
    `SELECT v.id, v."encryptedLocator", v."healthScore", v."healthStatus", s.status AS source_status, s.priority AS source_priority, s.priority
     FROM "StreamVariant" v JOIN "Source" s ON s.id = v."sourceId" JOIN "Channel" c ON c.id = v."channelId"
     WHERE ${channelFilter} AND v."isActive" AND s.status <> 'DISABLED'
     ORDER BY v."healthScore" DESC, s.priority ASC`,
    params,
  );
  if (result.rows.length === 0) return null;
  return (
    result.rows.find((row) => row.healthStatus !== "DOWN") ?? result.rows[0]
  );
}

export async function assertGrantActive(env, deviceId) {
  if (!deviceId) return false;
  const deviceHash = await sha256Hex(deviceId);
  const result = await env.db.query(
    env,
    `SELECT g.id FROM "DeviceGrant" g JOIN "AccessCode" a ON a.id = g."accessCodeId"
     WHERE g."deviceHash" = $1 AND g."expiresAt" > now() AND a.active AND a."revokedAt" IS NULL LIMIT 1`,
    [deviceHash],
  );
  return result.rows.length > 0;
}

export function playResponse(env, providerUrl) {
  const proxyUrl = (env.VIDEO_PROXY_URL ?? "").trim().replace(/\/+$/, "");
  if (!proxyUrl) throw new Error("VIDEO_PROXY_URL non configurée");
  return {
    url: `${proxyUrl}/?url=${encodeURIComponent(providerUrl)}`,
    expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
  };
}

export async function channelIsVisible(env, channelId) {
  const hiddenIds = await loadHiddenIds(env);
  const category = categoryFilterSql(hiddenIds, null, 'c', 2);
  const result = await env.db.query(
    env,
    `SELECT 1 FROM "Channel" c WHERE c.id = $1 AND c."isVisible" = true AND EXISTS (
       SELECT 1 FROM "StreamVariant" v JOIN "Source" s ON s.id = v."sourceId"
       WHERE v."channelId" = c.id AND v."isActive" AND s.status <> 'DISABLED'
     )${category.sql} LIMIT 1`,
    [channelId, ...category.params],
  );
  return result.rows.length > 0;
}
