/**
 * Notifications côté Worker : REST consommé par le PWA (abonnements push,
 * rappels par appareil, annonces publiées) + routes owner de rédaction.
 * L'ENVOI effectif des push est porté par l'API NestJS (cron + web-push),
 * sur la même base — le Worker ne fait que lire/écrire.
 */

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

export async function subscribe(env, deviceId, body) {
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : null;
  const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : null;
  const auth = typeof body?.keys?.auth === "string" ? body.keys.auth : null;
  if (!endpoint || !p256dh || !auth) return null;
  await env.db.query(
    env,
    `INSERT INTO "PushSubscription" ("deviceId", "endpoint", "p256dh", "auth")
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ("endpoint") DO UPDATE SET "deviceId" = EXCLUDED."deviceId", "p256dh" = EXCLUDED."p256dh", "auth" = EXCLUDED."auth"`,
    [deviceId, endpoint, p256dh, auth],
  );
  return { ok: true };
}

export async function unsubscribe(env, deviceId) {
  await env.db.query(env, `DELETE FROM "PushSubscription" WHERE "deviceId" = $1`, [deviceId]);
  return { ok: true };
}

export async function listReminders(env, deviceId) {
  const rows = await env.db.query(
    env,
    `SELECT "programmeId", "channelId", "channelName", title, "startsAt", "endsAt", fired
     FROM "ProgrammeReminder" WHERE "deviceId" = $1 ORDER BY "startsAt" ASC`,
    [deviceId],
  );
  return {
    items: rows.rows.map((row) => ({
      programmeId: row.programmeId,
      channelId: row.channelId,
      channelName: row.channelName,
      title: row.title,
      startsAt: iso(row.startsAt),
      endsAt: iso(row.endsAt),
      fired: row.fired,
    })),
  };
}

export async function addReminder(env, deviceId, body) {
  const programmeId = typeof body?.programmeId === "string" ? body.programmeId : null;
  const channelId = typeof body?.channelId === "string" ? body.channelId : null;
  const channelName = typeof body?.channelName === "string" ? body.channelName : null;
  const title = typeof body?.title === "string" ? body.title : null;
  const startsAt = typeof body?.startsAt === "string" ? body.startsAt : null;
  const endsAt = typeof body?.endsAt === "string" ? body.endsAt : null;
  if (!programmeId || !channelId || !channelName || !title || !startsAt || !endsAt) return null;
  await env.db.query(
    env,
    `INSERT INTO "ProgrammeReminder" ("deviceId", "programmeId", "channelId", "channelName", title, "startsAt", "endsAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT ("deviceId", "programmeId") DO UPDATE SET
       title = EXCLUDED.title, "channelName" = EXCLUDED."channelName",
       "startsAt" = EXCLUDED."startsAt", "endsAt" = EXCLUDED."endsAt", fired = false`,
    [deviceId, programmeId, channelId, channelName, title.slice(0, 200), new Date(startsAt), new Date(endsAt)],
  );
  return { ok: true };
}

export async function removeReminder(env, deviceId, programmeId) {
  await env.db.query(env, `DELETE FROM "ProgrammeReminder" WHERE "deviceId" = $1 AND "programmeId" = $2`, [deviceId, programmeId]);
  return { ok: true };
}

export async function listPublished(env) {
  const rows = await env.db.query(
    env,
    `SELECT id, title, body, kind, status, "createdAt", "sentAt" FROM "Announcement"
     WHERE status = 'SENT' ORDER BY "createdAt" DESC LIMIT 50`,
  );
  return { items: rows.rows.map(mapAnnouncement) };
}

function mapAnnouncement(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    kind: row.kind,
    status: row.status,
    createdAt: iso(row.createdAt),
    sentAt: row.sentAt ? iso(row.sentAt) : null,
  };
}

/* ---------- Owner ---------- */

export async function ownerList(env, userId) {
  const rows = await env.db.query(
    env,
    `SELECT id, title, body, kind, status, "createdAt", "sentAt" FROM "Announcement" ORDER BY "createdAt" DESC LIMIT 100`,
  );
  return { items: rows.rows.map(mapAnnouncement) };
}

export async function ownerCreate(env, body) {
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const text = typeof body?.body === "string" ? body.body.trim() : "";
  const kind = ["INFO", "VERSION", "PROMO"].includes(body?.kind) ? body.kind : "INFO";
  if (title.length < 3 || title.length > 80 || text.length < 3 || text.length > 500) return null;
  const rows = await env.db.query(
    env,
    `INSERT INTO "Announcement" (title, body, kind) VALUES ($1, $2, $3) RETURNING id, title, body, kind, status, "createdAt", "sentAt"`,
    [title, text, kind],
  );
  return mapAnnouncement(rows.rows[0]);
}

export async function ownerPublish(env, id) {
  const rows = await env.db.query(
    env,
    `UPDATE "Announcement" SET status = 'SENT' WHERE id = $1 RETURNING id, title, body, kind, status, "createdAt", "sentAt"`,
    [id],
  );
  return rows.rows[0] ? mapAnnouncement(rows.rows[0]) : null;
}

export async function ownerRemove(env, id) {
  await env.db.query(env, `DELETE FROM "Announcement" WHERE id = $1`, [id]);
  return { ok: true };
}
