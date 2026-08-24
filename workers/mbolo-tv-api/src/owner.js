import { signJwt, verifyJwt } from './jwt.js';
import { verifyPassword } from './password.js';
import { sha256Hex } from './crypto.js';

export const OWNER_COOKIE = 'mbolo_owner_session';

export function parseCookies(request) {
  const header = request.headers.get('cookie') ?? '';
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function sessionCookie(token, maxAgeSeconds, secure) {
  return `${OWNER_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie(secure) {
  return `${OWNER_COOKIE}=; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}; Max-Age=0`;
}

// Équivalent OwnerGuard.validateRequest : la table OwnerSession est la source
// de vérité (jti = id), plafond absolu + fenêtre glissante renouvelée à mi-vie.
export async function requireOwner(ctx) {
  const token = parseCookies(ctx.request)[OWNER_COOKIE];
  if (!token) return null;
  const payload = await verifyJwt(ctx.env.JWT_ACCESS_SECRET, token);
  if (!payload || payload.purpose !== 'owner-session' || payload.role !== 'OWNER' || !payload.jti) return null;
  const rows = await ctx.env.db.query(
    ctx.env,
    `SELECT s.id, s."userId", s."expiresAt", s."createdAt", u.email, u.role FROM "OwnerSession" s JOIN "User" u ON u.id = s."userId"
     WHERE s.id = $1 AND s."revokedAt" IS NULL`,
    [payload.jti],
  );
  const session = rows.rows[0];
  if (!session || session.role !== 'OWNER') return null;
  const absoluteTtlHours = Number(ctx.env.OWNER_SESSION_ABSOLUTE_TTL_HOURS ?? 8);
  if (Date.now() - new Date(session.createdAt).getTime() > absoluteTtlHours * 3_600_000) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null;

  const idleTtlMinutes = Number(ctx.env.OWNER_SESSION_TTL_MINUTES ?? 30);
  const remainingMs = new Date(session.expiresAt).getTime() - Date.now();
  if (remainingMs < (idleTtlMinutes * 60_000) / 2) {
    await ctx.env.db.query(ctx.env, `UPDATE "OwnerSession" SET "expiresAt" = now() + ($2 || ' minutes')::interval WHERE id = $1`, [session.id, String(idleTtlMinutes)]);
  }
  return { userId: session.userId, email: session.email, sessionId: session.id };
}

const loginBuckets = new Map();

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const entry = loginBuckets.get(key);
  if (!entry || entry.reset <= now) {
    loginBuckets.set(key, { count: 1, reset: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  entry.count += 1;
  if (entry.count > limit) return { allowed: false, retryAfterSeconds: Math.ceil((entry.reset - now) / 1000) };
  return { allowed: true, retryAfterSeconds: 0 };
}

export async function ownerLogin(ctx, email, password) {
  const ip = ctx.request.headers.get('cf-connecting-ip') ?? '';
  const byAccount = rateLimit(`owner-login:${email}`, Number(ctx.env.OWNER_LOGIN_MAX_ATTEMPTS ?? 5), 15 * 60_000);
  const byIp = rateLimit(`owner-login-ip:${ip}`, Number(ctx.env.OWNER_LOGIN_MAX_PER_IP ?? 20), 3_600_000);
  if (!byAccount.allowed || !byIp.allowed) {
    return { status: 429, retryAfterSeconds: Math.max(byAccount.retryAfterSeconds, byIp.retryAfterSeconds) };
  }

  const normalizedEmail = email.trim().toLowerCase();
  const rows = await ctx.env.db.query(ctx.env, `SELECT id, email, role, "passwordHash" FROM "User" WHERE email = $1 LIMIT 1`, [normalizedEmail]);
  const user = rows.rows[0];
  const valid = user && user.role === "OWNER" && user.passwordHash && (await verifyPassword(user.passwordHash, password));
  if (!valid) {
    console.error("[auth] login échec:", { trouvé: Boolean(user), role: user?.role, hashPrefix: user?.passwordHash?.slice(0, 15), passLen: password.length });
    return { status: 401, message: "Identifiants invalides" };
  }

  const idleTtlMinutes = Number(ctx.env.OWNER_SESSION_TTL_MINUTES ?? 30);
  const absoluteTtlHours = Number(ctx.env.OWNER_SESSION_ABSOLUTE_TTL_HOURS ?? 8);
  const sessionId = crypto.randomUUID();
  await ctx.env.db.query(
    ctx.env,
    `INSERT INTO "OwnerSession" (id, "userId", "userAgent", "ipHash", "expiresAt") VALUES ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval)`,
    [sessionId, user.id, (ctx.request.headers.get('user-agent') ?? '').slice(0, 200) || null, (await sha256Hex(ip)).slice(0, 16), String(idleTtlMinutes)],
  );
  const tokenTtlSeconds = Math.max(idleTtlMinutes * 60, absoluteTtlHours * 3_600);
  const token = await signJwt(ctx.env.JWT_ACCESS_SECRET, { purpose: 'owner-session', sub: user.id, email: user.email, role: 'OWNER', jti: sessionId }, tokenTtlSeconds);
  await ctx.env.db.query(
    ctx.env,
    `INSERT INTO "AuditLog" (id, "actorId", action, entity, "entityId", metadata, "createdAt") VALUES ($1,$2,'owner.login','owner',$2,$3, now())`,
    [crypto.randomUUID(), user.id, JSON.stringify({ sessionId })],
  ).catch(() => undefined);
  return {
    status: 200,
    cookie: sessionCookie(token, tokenTtlSeconds, ctx.env.NODE_ENV !== 'development'),
    value: { me: { id: user.id, email: user.email, role: user.role }, sessionId },
  };
}

export async function ownerLogout(ctx) {
  const token = parseCookies(ctx.request)[OWNER_COOKIE];
  if (token) {
    const payload = await verifyJwt(ctx.env.JWT_ACCESS_SECRET, token);
    if (payload?.jti) {
      const updated = await ctx.env.db.query(ctx.env, `UPDATE "OwnerSession" SET "revokedAt" = now() WHERE id = $1 AND "revokedAt" IS NULL RETURNING "userId"`, [payload.jti]);
      if (updated.rows[0]) {
        await ctx.env.db.query(
          ctx.env,
          `INSERT INTO "AuditLog" (id, "actorId", action, entity, "entityId", metadata, "createdAt") VALUES ($1,$2,'owner.logout','owner',$2,'{}'::jsonb, now())`,
          [crypto.randomUUID(), updated.rows[0].userId],
        ).catch(() => undefined);
      }
    }
  }
  return clearCookie(true);
}
