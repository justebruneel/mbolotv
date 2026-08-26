// Chaînes « mises en avant » par pays, curées depuis la console propriétaire.
// La table est créée paresseusement (pas de pipeline de migration côté worker).
// Endpoint public : /api/geo/featured déduit le pays du visiteur de Cloudflare
// (request.cf.country — gratuit, sans service externe) avec ?country=XX pour
// tester ; renvoie la sélection du pays s'il en existe une.
import { resolveLogoUrl } from './channels.js';

const ACTIVE_VARIANT = `EXISTS (SELECT 1 FROM "StreamVariant" v WHERE v."channelId" = "Channel".id AND v."isActive")`;

let schemaReady = null;

export function ensureFeaturedTable(env) {
  if (!schemaReady) {
    schemaReady = env.db
      .query(
        env,
        `CREATE TABLE IF NOT EXISTS "FeaturedChannel" (
           "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
           "country" TEXT NOT NULL,
           "channelId" TEXT NOT NULL REFERENCES "Channel"(id) ON DELETE CASCADE,
           "sortOrder" INTEGER NOT NULL DEFAULT 0,
           "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
           UNIQUE ("country", "channelId")
         )`,
      )
      .catch((error) => {
        console.error('featured schema:', String(error?.message ?? error));
        schemaReady = null;
        throw error;
      });
  }
  return schemaReady;
}

function normalizeCountry(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 2);
}

export async function geoFeatured(ctx, url) {
  const { env } = ctx;
  const override = url.searchParams.get('country');
  const country = normalizeCountry(override ?? ctx.request.cf?.country ?? '');
  if (!country) return ctx.json({ country: null, channels: [] });
  try {
    await ensureFeaturedTable(env);
    const rows = await env.db.query(
      env,
      `SELECT c.id, c.name, c."canonicalName", c."categoryId", c.country, c."logoKey"
       FROM "FeaturedChannel" f JOIN "Channel" c ON c.id = f."channelId"
       WHERE UPPER(f."country") = $1 AND c."isVisible"
         AND EXISTS (SELECT 1 FROM "StreamVariant" v WHERE v."channelId" = c.id AND v."isActive")
       ORDER BY f."sortOrder" ASC, c.name ASC LIMIT 24`,
      [country],
    );
    return ctx.json({
      country,
      channels: rows.rows.map((row) => ({
        id: row.id,
        name: row.name,
        canonicalName: row.canonicalName,
        categoryId: row.categoryId,
        country: row.country,
        logoUrl: resolveLogoUrl(env, row.logoKey),
      })),
    });
  } catch {
    // Dégradation gracieuse : pas de sélection locale plutôt qu'une erreur,
    // la rangée « Chaînes locales » disparaît simplement de la page live.
    return ctx.json({ country, channels: [] });
  }
}

export async function featuredList(ctx) {
  const { env } = ctx;
  await ensureFeaturedTable(env);
  const rows = await env.db.query(
    env,
    `SELECT f."country", f."channelId", c.name, c."logoKey"
     FROM "FeaturedChannel" f LEFT JOIN "Channel" c ON c.id = f."channelId"
     ORDER BY UPPER(f."country") ASC, f."sortOrder" ASC, c.name ASC`,
  );
  const groups = new Map();
  for (const row of rows.rows) {
    const group = groups.get(row.country) ?? { country: row.country, channels: [] };
    group.channels.push({
      id: row.channelId,
      name: row.name ?? 'Chaîne supprimée',
      logoUrl: row.logoKey ? resolveLogoUrl(env, row.logoKey) : null,
    });
    groups.set(row.country, group);
  }
  return ctx.json({ items: [...groups.values()] });
}

export async function featuredSet(ctx, owner, audit, countryRaw, body) {
  const { env } = ctx;
  const country = normalizeCountry(countryRaw);
  if (country.length !== 2) return ctx.fail(400, 'Code pays invalide (ISO alpha-2 attendu)');
  const channelIds = Array.isArray(body?.channelIds)
    ? [...new Set(body.channelIds.filter((value) => typeof value === 'string'))].slice(0, 50)
    : null;
  if (!channelIds) return ctx.fail(400, 'channelIds requis');
  await ensureFeaturedTable(env);
  if (channelIds.length > 0) {
    const found = await env.db.query(env, `SELECT id FROM "Channel" WHERE id = ANY($1::text[])`, [channelIds]);
    if ((found.rowCount ?? 0) !== channelIds.length) return ctx.fail(400, 'Certaines chaînes sont introuvables');
  }
  await env.db.query(env, `DELETE FROM "FeaturedChannel" WHERE UPPER("country") = $1::text`, [country]);
  for (const [index, channelId] of channelIds.entries()) {
    await env.db.query(
      env,
      `INSERT INTO "FeaturedChannel" ("country", "channelId", "sortOrder") VALUES ($1::text, $2::text, $3::int) ON CONFLICT ("country", "channelId") DO NOTHING`,
      [country, channelId, index],
    );
  }
  await audit(ctx, owner.userId, 'catalog.featured_set', 'channel', null, { country, count: channelIds.length });
  return featuredList(ctx);
}

export async function featuredRemove(ctx, owner, audit, countryRaw, channelId) {
  const { env } = ctx;
  const country = normalizeCountry(countryRaw);
  await ensureFeaturedTable(env);
  const result = await env.db.query(env, `DELETE FROM "FeaturedChannel" WHERE UPPER("country") = $1 AND "channelId" = $2`, [country, channelId]);
  await audit(ctx, owner.userId, 'catalog.featured_remove', 'channel', channelId, { country, removed: result.rowCount ?? 0 });
  return featuredList(ctx);
}
