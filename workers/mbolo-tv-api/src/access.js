import { sha256Hex } from "./crypto.js";

const DEFAULT_WHATSAPP_URL = "https://wa.me/qr/CPB7IL3GHAGIK1";

async function findGrant(env, deviceId) {
  if (!deviceId) return null;
  const deviceHash = await sha256Hex(deviceId);
  const result = await env.db.query(
    env,
    `SELECT g.id, g."expiresAt", a.kind FROM "DeviceGrant" g JOIN "AccessCode" a ON a.id = g."accessCodeId"
     WHERE g."deviceHash" = $1 AND g."expiresAt" > now() AND a.active AND a."revokedAt" IS NULL
     ORDER BY g."expiresAt" DESC LIMIT 1`,
    [deviceHash],
  );
  const grant = result.rows[0] ?? null;
  if (grant)
    await env.db.query(
      env,
      `UPDATE "DeviceGrant" SET "lastSeenAt" = now() WHERE id = $1`,
      [grant.id],
    );
  return grant;
}

async function resolveWhatsappUrl(env) {
  const owner = await env.db.query(
    env,
    `SELECT "whatsappContact" FROM "User" WHERE role = 'OWNER' AND "whatsappContact" IS NOT NULL LIMIT 1`,
  );
  const contact = owner.rows[0]?.whatsappContact;
  if (!contact) return DEFAULT_WHATSAPP_URL;
  const trimmed = contact.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length >= 8) return `https://wa.me/${digits}`;
  return DEFAULT_WHATSAPP_URL;
}

export async function accessStatus(env, deviceId) {
  const grant = await findGrant(env, deviceId);
  return {
    active: Boolean(grant),
    expiresAt: grant ? grant.expiresAt.toISOString() : null,
    kind: grant ? (grant.kind === "PROMO" ? "PROMO" : "STANDARD") : null,
    whatsappUrl: await resolveWhatsappUrl(env),
  };
}

export async function redeemCode(env, code, deviceId, userAgent, ip) {
  const normalized = code.trim().toUpperCase();
  const codeHash = await sha256Hex(normalized);
  const rows = await env.db.query(
    env,
    `SELECT * FROM "AccessCode" WHERE "codeHash" = $1 LIMIT 1`,
    [codeHash],
  );
  const accessCode = rows.rows[0];
  if (!accessCode || !accessCode.active || accessCode.revokedAt)
    return { status: 403, message: "Code invalide ou désactivé" };
  const deviceHash = await sha256Hex(deviceId);

  if (
    accessCode.id &&
    (
      await env.db.query(
        env,
        `SELECT 1 FROM "DeviceGrant" WHERE "accessCodeId" = $1 LIMIT 1`,
        [accessCode.id],
      )
    ).rows.length > 0
  ) {
    const existing = await env.db.query(
      env,
      `SELECT * FROM "DeviceGrant" WHERE "accessCodeId" = $1 LIMIT 1`,
      [accessCode.id],
    );
    if (existing.rows[0].deviceHash !== deviceHash)
      return {
        status: 409,
        message: "Ce code est déjà lié à un autre appareil",
      };
    if (existing.rows[0].expiresAt <= new Date())
      return { status: 403, message: "Ce code a expiré" };
    await env.db.query(
      env,
      `UPDATE "DeviceGrant" SET "lastSeenAt" = now() WHERE id = $1`,
      [existing.rows[0].id],
    );
    return { status: 200, value: await accessStatus(env, deviceId) };
  }

  // Prolongement : la durée du nouveau code s'ajoute à l'accès actif restant
  // (pas à maintenant), sinon un code plus court que le temps restant serait
  // perdu — findGrant retenant l'expiration la plus lointaine.
  const currentGrant = await findGrant(env, deviceId);
  const baseTime = currentGrant ? Math.max(new Date(currentGrant.expiresAt).getTime(), Date.now()) : Date.now();
  const expiresAt = new Date(baseTime + accessCode.durationHours * 3_600_000);
  try {
    // L'id de DeviceGrant n'a pas de défaut en base (défaut Prisma applicatif) :
    // il doit être fourni explicitement ici.
    await env.db.query(
      env,
      `INSERT INTO "DeviceGrant" ("id", "accessCodeId", "deviceHash", "userAgent", "ipHash", "expiresAt")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        crypto.randomUUID(),
        accessCode.id,
        deviceHash,
        userAgent?.slice(0, 200) ?? null,
        await sha256Hex(ip ?? ""),
        expiresAt,
      ],
    );
  } catch (error) {
    // Conflit réel d'unicité (course : deux appareils réclament en même temps)
    // = 409 ; toute autre erreur SQL ne doit pas être masquée par ce message.
    if (error?.code === '23505') {
      return {
        status: 409,
        message: "Ce code vient d’être utilisé sur un autre appareil",
      };
    }
    console.error('access.redeem insert:', String(error?.message ?? error));
    return {
      status: 500,
      message: "Impossible d'activer ce code pour le moment, réessayez.",
    };
  }
  await env.db.query(
    env,
    `INSERT INTO "AuditLog" (id, "actorId", action, entity, "entityId", metadata, "createdAt")
     VALUES ($1, NULL, 'access.redeem', 'access_code', $2, $3, now())`,
    [
      crypto.randomUUID(),
      accessCode.id,
      JSON.stringify({
        kind: accessCode.kind,
        expiresAt: expiresAt.toISOString(),
      }),
    ],
  );
  return { status: 200, value: await accessStatus(env, deviceId) };
}
