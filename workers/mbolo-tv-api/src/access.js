import { sha256Hex } from "./crypto.js";

const DEFAULT_WHATSAPP_URL = "https://wa.me/qr/CPB7IL3GHAGIK1";

// Bornes par défaut du rate limit de /access/redeem (surchargeables par env).
const REDEEM_WINDOW_MINUTES = 15;
const REDEEM_MAX_PER_IP = 30;
const REDEEM_MAX_PER_DEVICE = 10;

// Outcomes qui comptent comme échec pour le rate limit. RATE_LIMITED en est
// volontairement EXCLU : sinon un client bloqué qui réessaie repousse sans
// cesse la sortie de la fenêtre et se bloque lui-même indéfiniment. OK aussi
// (un rachat réussi n'est pas un échec). Cette liste est la source unique ;
// la requête de comptage et la purge s'y réfèrent.
const FAILED_OUTCOMES = [
  "INVALID_CODE",
  "ALREADY_BOUND",
  "EXPIRED",
  "DEVICE_REVOKED",
];

function intEnv(env, name, fallback) {
  const parsed = Number(env?.[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function findGrant(env, deviceId) {
  if (!deviceId) return null;
  const deviceHash = await sha256Hex(deviceId);
  const result = await env.db.query(
    env,
    `SELECT g.id, g."expiresAt", a.kind FROM "DeviceGrant" g JOIN "AccessCode" a ON a.id = g."accessCodeId"
     WHERE g."deviceHash" = $1 AND g."expiresAt" > now() AND g."revokedAt" IS NULL
       AND a.active AND a."revokedAt" IS NULL
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

// Journal des tentatives de rachat. Écrit en base (et non en mémoire) : une Map
// d'isolate est perdue à chaque redéploiement et n'est pas partagée entre
// instances — elle ne protège pas un bruteforce distribué. Un échec d'écriture
// ne doit jamais bloquer un rachat légitime, d'où le catch silencieux.
async function recordAttempt(env, { codeHash, deviceHash, ipHash, outcome }) {
  await env.db
    .query(
      env,
      `INSERT INTO "AccessAttempt" ("id", "codeHash", "deviceHash", "ipHash", outcome) VALUES ($1,$2,$3,$4,$5)`,
      [crypto.randomUUID(), codeHash ?? null, deviceHash ?? null, ipHash ?? null, outcome],
    )
    .catch(() => undefined);
}

// Un rachat réussi efface les échecs de CET appareil : sans cela, un client
// ayant fait quelques fautes de frappe resterait bloqué par ses propres
// échecs alors qu'il détient enfin le bon code. Un attaquant qui possède un
// code valide n'a pas besoin de bruteforcer — la remise à zéro ne lui donne
// rien. Les lignes RATE_LIMITED/OK ne comptant pas, elles peuvent rester
// (purge cron) ; on ne supprime que ce qui pèse sur le compteur.
async function clearFailures(env, deviceHash) {
  await env.db
    .query(
      env,
      `DELETE FROM "AccessAttempt" WHERE "deviceHash" = $1 AND outcome = ANY($2)`,
      [deviceHash, FAILED_OUTCOMES],
    )
    .catch(() => undefined);
}

/** Compte les échecs récents par IP et par appareil. `ipHash` nul (IP absente,
 * appel hors Cloudflare) neutralise la borne IP plutôt que de faire converger
 * tous ces appels vers un même compteur — la borne appareil reste active.
 * Un `oldest` nul (aucun échec) n'est pas atteint : la garde ne bloque que si
 * un compteur a franchi son seuil. */
async function redeemRateLimit(env, ipHash, deviceHash) {
  const windowMinutes = intEnv(env, "ACCESS_REDEEM_WINDOW_MINUTES", REDEEM_WINDOW_MINUTES);
  const result = await env.db.query(
    env,
    `SELECT
       COUNT(*) FILTER (WHERE "ipHash" = $1)::int AS ip_failures,
       COUNT(*) FILTER (WHERE "deviceHash" = $2)::int AS device_failures,
       MIN("createdAt") FILTER (WHERE "ipHash" = $1 OR "deviceHash" = $2) AS oldest
     FROM "AccessAttempt"
     WHERE "createdAt" > now() - ($3 || ' minutes')::interval AND outcome = ANY($4)`,
    [ipHash, deviceHash, String(windowMinutes), FAILED_OUTCOMES],
  );
  const row = result.rows[0] ?? {};
  const maxPerIp = intEnv(env, "ACCESS_REDEEM_MAX_PER_IP", REDEEM_MAX_PER_IP);
  const maxPerDevice = intEnv(env, "ACCESS_REDEEM_MAX_PER_DEVICE", REDEEM_MAX_PER_DEVICE);
  if ((row.ip_failures ?? 0) < maxPerIp && (row.device_failures ?? 0) < maxPerDevice)
    return { blocked: false, retryAfterSeconds: 0 };
  // La fenêtre glisse : le déblocage tombe quand le plus ancien échec en sort.
  const oldest = row.oldest ? new Date(row.oldest).getTime() : Date.now();
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((oldest + windowMinutes * 60_000 - Date.now()) / 1000),
  );
  return { blocked: true, retryAfterSeconds };
}

// L'ID d'un DeviceGrant n'a pas de défaut en base (défaut Prisma applicatif) :
// il doit être fourni explicitement à l'insertion.
const INSERT_GRANT_SQL = `INSERT INTO "DeviceGrant" ("id", "accessCodeId", "deviceHash", "userAgent", "ipHash", "expiresAt")
   VALUES ($1, $2, $3, $4, $5, $6)`;

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
  const deviceHash = await sha256Hex(deviceId);
  const ipHash = ip ? await sha256Hex(ip) : null;
  const attempt = { codeHash, deviceHash, ipHash };

  const limit = await redeemRateLimit(env, ipHash, deviceHash);
  if (limit.blocked) {
    await recordAttempt(env, { ...attempt, outcome: "RATE_LIMITED" });
    return {
      status: 429,
      message: "Trop de tentatives, réessayez dans quelques minutes.",
      retryAfterSeconds: limit.retryAfterSeconds,
    };
  }

  const rows = await env.db.query(
    env,
    `SELECT * FROM "AccessCode" WHERE "codeHash" = $1 LIMIT 1`,
    [codeHash],
  );
  const accessCode = rows.rows[0];
  if (!accessCode || !accessCode.active || accessCode.revokedAt) {
    await recordAttempt(env, { ...attempt, outcome: "INVALID_CODE" });
    return { status: 403, message: "Code invalide ou désactivé" };
  }

  const existingRows = await env.db.query(
    env,
    `SELECT * FROM "DeviceGrant" WHERE "accessCodeId" = $1 LIMIT 1`,
    [accessCode.id],
  );
  const existing = existingRows.rows[0];

  if (existing) {
    // Un appareil révoqué ne peut pas se réinscrire avec le même code : c'est
    // le sens même de la révocation. Le propriétaire émet un nouveau code.
    if (existing.revokedAt) {
      await recordAttempt(env, { ...attempt, outcome: "DEVICE_REVOKED" });
      return { status: 403, message: "Cet appareil a été révoqué" };
    }
    if (existing.deviceHash !== deviceHash) {
      await recordAttempt(env, { ...attempt, outcome: "ALREADY_BOUND" });
      return { status: 409, message: "Ce code est déjà lié à un autre appareil" };
    }
    if (existing.expiresAt <= new Date()) {
      await recordAttempt(env, { ...attempt, outcome: "EXPIRED" });
      return { status: 403, message: "Ce code a expiré" };
    }
    await env.db.query(
      env,
      `UPDATE "DeviceGrant" SET "lastSeenAt" = now() WHERE id = $1`,
      [existing.id],
    );
    await recordAttempt(env, { ...attempt, outcome: "OK" });
    await clearFailures(env, deviceHash);
    return { status: 200, value: await accessStatus(env, deviceId) };
  }

  // Prolongement : la durée du nouveau code s'ajoute à l'accès actif restant
  // (pas à maintenant), sinon un code plus court que le temps restant serait
  // perdu — findGrant retenant l'expiration la plus lointaine.
  const currentGrant = await findGrant(env, deviceId);
  const baseTime = currentGrant ? Math.max(new Date(currentGrant.expiresAt).getTime(), Date.now()) : Date.now();
  const expiresAt = new Date(baseTime + accessCode.durationHours * 3_600_000);
  try {
    await env.db.query(env, INSERT_GRANT_SQL, [
      crypto.randomUUID(),
      accessCode.id,
      deviceHash,
      userAgent?.slice(0, 200) ?? null,
      ipHash,
      expiresAt,
    ]);
  } catch (error) {
    // Conflit réel d'unicité (course : deux appareils réclament en même temps)
    // = 409 ; toute autre erreur SQL ne doit pas être masquée par ce message.
    if (error?.code === '23505') {
      await recordAttempt(env, { ...attempt, outcome: "ALREADY_BOUND" });
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
  await recordAttempt(env, { ...attempt, outcome: "OK" });
  await clearFailures(env, deviceHash);
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
