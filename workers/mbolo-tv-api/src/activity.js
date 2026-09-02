import { sha256Hex } from "./crypto.js";

const TTL_SECONDS = 60;

// Remplace ActivityService (Redis) par une table Neon à TTL applicatif :
// un heartbeat = upsert, les compteurs filtrent sur la fenêtre de 60 s.
export async function heartbeat(env, deviceId, channelId) {
  const deviceHash = await sha256Hex(deviceId ?? "");
  await env.db.query(
    env,
    `INSERT INTO "ActivityHeartbeat" ("deviceHash", "channelId", "lastSeenAt")
     VALUES ($1, $2, now())
     ON CONFLICT ("deviceHash") DO UPDATE SET "channelId" = EXCLUDED."channelId", "lastSeenAt" = now()`,
    [deviceHash, channelId ?? null],
  );
  if (Math.random() < 0.05) {
    await env.db
      .query(
        env,
        `DELETE FROM "ActivityHeartbeat" WHERE "lastSeenAt" < now() - interval '5 minutes'`,
      )
      .catch(() => undefined);
  }
}

export async function globalCount(env) {
  const result = await env.db.query(
    env,
    `SELECT COUNT(*)::int AS count FROM "ActivityHeartbeat" WHERE "lastSeenAt" > now() - interval '${TTL_SECONDS} seconds'`,
  );
  return result.rows[0].count;
}

export async function channelCount(env, channelId) {
  const result = await env.db.query(
    env,
    `SELECT COUNT(*)::int AS count FROM "ActivityHeartbeat" WHERE "channelId" = $1 AND "lastSeenAt" > now() - interval '${TTL_SECONDS} seconds'`,
    [channelId],
  );
  return result.rows[0].count;
}

// Affluence réelle pour l'éco adaptatif : nombre de chaînes DISTINCTES
// regardées dans la fenêtre. Grâce à la mutualisation du proxy, le relais
// résidentiel porte ~1 flux par chaîne active, quel que soit le nombre de
// spectateurs — c'est donc ce compteur (et non le nombre de viewers) qui
// mesure la charge. Fenêtre 120 s : au-dessus du TTL heartbeat (60 s) pour
// tolérer un battement. Mémo 10 s en mémoire d'isolate : les /play en rafale
// partagent la même valeur au lieu de marteler Neon.
const CHANNEL_COUNT_CACHE_MS = 10_000;
let channelCountCache = { at: 0, value: 0 };

export async function activeChannelCount(env, windowSeconds = 120) {
  const now = Date.now();
  if (now - channelCountCache.at < CHANNEL_COUNT_CACHE_MS) return channelCountCache.value;
  const seconds = Math.max(1, Math.floor(Number(windowSeconds) || 120));
  const result = await env.db.query(
    env,
    `SELECT COUNT(DISTINCT "channelId")::int AS count FROM "ActivityHeartbeat"
     WHERE "channelId" IS NOT NULL AND "lastSeenAt" > now() - interval '${seconds} seconds'`,
  );
  const value = result.rows[0]?.count ?? 0;
  channelCountCache = { at: now, value };
  return value;
}
