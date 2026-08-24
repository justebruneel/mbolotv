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
