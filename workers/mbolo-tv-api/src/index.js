import { withClient } from "./db.js";
import { decryptLocatorWithSecret } from "./crypto.js";
import * as categoriesRepo from "./categories.js";
import * as channels from "./channels.js";
import * as matches from "./matches.js";
import * as epg from "./epg.js";
import * as activity from "./activity.js";
import * as access from "./access.js";
import * as favorites from "./favorites.js";
import { selectVariant, assertGrantActive, playResponse } from "./play.js";
import { handleOwnerRoute, resumeQueuedImports } from "./owner-routes.js";
import { scanDueVariants } from "./healthcheck.js";
import { discoverMatches } from "./discovery.js";
import { runEpgImportForSource } from "./epgimport.js";
import { geoFeatured } from "./featured.js";

function corsHeaders(request, env) {
  const allowed = (env?.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const origin = request.headers.get("origin");
  const headers = {
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-device-id,cookie,set-cookie",
    vary: "Origin",
  };
  if (allowed.length === 0 || (origin && allowed.includes(origin))) {
    headers["access-control-allow-origin"] = origin ?? "*";
  }
  return headers;
}

class Ctx {
  constructor(request, env, event) {
    this.request = request;
    this.env = env;
    this.event = event;
  }

  corsHeaders() {
    return corsHeaders(this.request, this.env);
  }

  json(value, status = 200) {
    return new Response(JSON.stringify(value), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...corsHeaders(this.request, this.env),
      },
    });
  }

  fail(status, message) {
    return this.json({ message, statusCode: status }, status);
  }

  readJson() {
    return readJson(this.request);
  }

  waitUntil(promise) {
    this.event?.waitUntil?.(promise);
  }
}

const MATCH_STATES = new Set(["SCHEDULED", "LIVE", "FINISHED", "POSTPONED"]);

function intParam(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text);
}

// Mur d'accès équivalent à StreamSessionGuard : l'URL de lecture n'est délivrée
// qu'aux appareils munis d'un DeviceGrant actif (x-device-id).
async function respondWithPlay(ctx, locatorPromise, maxHeight) {
  const deviceId = ctx.request.headers.get("x-device-id") ?? undefined;
  if (!(await assertGrantActive(ctx.env, deviceId)))
    return ctx.fail(403, "Un code d’accès actif est requis");
  let providerUrl;
  try {
    const raw = await locatorPromise;
    // Locator Stalker MAC (format : base|mac|channelId) → résolution à la volée.
    if (raw.includes("|")) {
      const { resolveStalkerLocator } = await import("./play.js");
      providerUrl = (await resolveStalkerLocator(ctx.env, raw)) ?? (() => { throw new Error("Résolution échouée"); })();
    } else {
      providerUrl = raw;
    }
  } catch {
    return ctx.fail(404, "Flux indisponible pour cette chaîne");
  }
  return ctx.json(await playResponse(ctx.env, providerUrl, maxHeight));
}

async function categoriesList(ctx) {
  const rows = await ctx.env.db.query(
    ctx.env,
    `SELECT id, slug, name, "parentId", "sortOrder", "isVisible" FROM "Category" ORDER BY "sortOrder" ASC, name ASC`,
  );
  const categoryRows = rows.rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    parentId: row.parentId,
    sortOrder: row.sortOrder,
    isVisible: row.isVisible,
  }));
  const byId = new Map(categoryRows.map((row) => [row.id, row]));
  const effective = new Map();
  const visiting = new Set();
  const computeEffective = (id) => {
    const cached = effective.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      effective.set(id, false);
      return false;
    }
    visiting.add(id);
    const node = byId.get(id);
    if (!node) {
      visiting.delete(id);
      return false;
    }
    const parentOk =
      node.parentId == null || !byId.has(node.parentId)
        ? true
        : computeEffective(node.parentId);
    visiting.delete(id);
    const result = node.isVisible && parentOk;
    effective.set(id, result);
    return result;
  };
  categoryRows.forEach((row) => computeEffective(row.id));

  const leaf = new Map();
  const counts = await ctx.env.db.query(
    ctx.env,
    `SELECT "categoryId", COUNT(*)::int AS count FROM "Channel" WHERE "isVisible" AND "categoryId" IS NOT NULL AND EXISTS (SELECT 1 FROM "StreamVariant" v WHERE v."channelId" = "Channel".id AND v."isActive") GROUP BY "categoryId"`,
  );
  for (const row of counts.rows) leaf.set(row.categoryId, row.count);

  const childrenByParent = new Map();
  for (const row of categoryRows) {
    const bucket = childrenByParent.get(row.parentId) ?? [];
    bucket.push(row);
    childrenByParent.set(row.parentId, bucket);
  }
  const buildVisiting = new Set();
  const build = (row) => {
    if (buildVisiting.has(row.id))
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        parentId: row.parentId,
        isVisible: row.isVisible,
        channelCount: 0,
        children: [],
      };
    buildVisiting.add(row.id);
    const rawChildren = (childrenByParent.get(row.id) ?? [])
      .filter((child) => effective.get(child.id))
      .map(build);
    buildVisiting.delete(row.id);
    const children = rawChildren.filter(
      (child) => (child.channelCount ?? 0) > 0,
    );
    const channelCount =
      (leaf.get(row.id) ?? 0) +
      children.reduce((sum, child) => sum + (child.channelCount ?? 0), 0);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      parentId: row.parentId,
      isVisible: row.isVisible,
      channelCount,
      children,
    };
  };

  const items = categoryRows
    .filter(
      (row) =>
        effective.get(row.id) &&
        (row.parentId == null ||
          !byId.has(row.parentId) ||
          !effective.get(row.parentId)),
    )
    .map(build)
    .filter((category) => (category.channelCount ?? 0) > 0);
  return ctx.json(items);
}

async function route(ctx, url) {
  const { env } = ctx;
  const path = url.pathname.replace(/\/+$/, "");
  const method = ctx.request.method;

  if (path === "/api/health" && method === "GET") {
    await withClient(env, async () => undefined);
    return ctx.json({ status: "ok" });
  }

  if (path === "/api/categories" && method === "GET")
    return categoriesList(ctx);

  if (path === "/api/geo/featured" && method === "GET")
    return geoFeatured(ctx, url);

  if (path === "/api/channels" && method === "GET") {
    return ctx.json(
      await channels.listChannels(env, {
        category: url.searchParams.get("category") ?? undefined,
        country: url.searchParams.get("country") ?? undefined,
        q: url.searchParams.get("q") ?? undefined,
        limit: intParam(url.searchParams.get("limit"), 48, 1, 100),
        offset: intParam(
          url.searchParams.get("offset"),
          0,
          0,
          Number.MAX_SAFE_INTEGER,
        ),
      }),
    );
  }

  if (path === "/api/channels/countries" && method === "GET")
    return ctx.json(await channels.countries(env));

  const channelMatch = path.match(/^\/api\/channels\/([^/]+)(\/(epg|play))?$/);

  if (channelMatch && channelMatch[3] === "play" && method === "GET") {
    const channelId = decodeURIComponent(channelMatch[1]);
    const ecoMaxHeight = url.searchParams.get("eco") === "1" ? 480 : undefined;
    const hiddenIds = await categoriesRepo.loadHiddenIds(env);
    const category = categoriesRepo.categoryFilterSql(hiddenIds, null, 'c', 2);
    const visible = await env.db.query(
      env,
      `SELECT 1 FROM "Channel" c WHERE c.id = $1 AND c."isVisible" = true${category.sql} LIMIT 1`,
      [channelId, ...category.params],
    );
    if (visible.rows.length === 0) return ctx.fail(404, "Channel not found");
    const variant = await selectVariant(env, channelId, null);
    if (!variant)
      return ctx.fail(404, "Aucun flux disponible pour cette chaîne");
    return respondWithPlay(
      ctx,
      decryptLocatorWithSecret(env.ENCRYPTION_KEY, variant.encryptedLocator),
      ecoMaxHeight,
    );
  }

  if (channelMatch && channelMatch[3] === "epg" && method === "GET") {
    const programmes = await channels.channelEpg(
      env,
      decodeURIComponent(channelMatch[1]),
    );
    if (!programmes) return ctx.fail(404, "Channel not found");
    return ctx.json(programmes);
  }

  if (channelMatch && !channelMatch[2] && method === "GET") {
    const found = await channels.findChannelById(
      env,
      decodeURIComponent(channelMatch[1]),
    );
    if (!found) return ctx.fail(404, "Channel not found");
    return ctx.json(found);
  }

  if (path === "/api/matches" && method === "GET") {
    const state = url.searchParams.get("state");
    if (state && !MATCH_STATES.has(state))
      return ctx.fail(
        400,
        `state doit être un de ${[...MATCH_STATES].join(", ")}`,
      );
    return ctx.json(
      await matches.listMatches(env, {
        state,
        sport: url.searchParams.get("sport") ?? undefined,
        from: url.searchParams.get("from") ?? undefined,
        to: url.searchParams.get("to") ?? undefined,
      }),
    );
  }

  const matchMatch = path.match(/^\/api\/matches\/([^/]+)(\/play)?$/);

  if (matchMatch && matchMatch[2] && method === "POST") {
    const matchEcoMaxHeight = url.searchParams.get("eco") === "1" ? 480 : undefined;
    const matchId = decodeURIComponent(matchMatch[1]);
    const found = await matches.findMatchVariants(env, matchId);
    if (!found) return ctx.fail(404, "Match not found");
    const body = await readJson(ctx.request).catch(() => ({}));
    const variants = found.variants.filter(
      (variant) =>
        variant.is_active &&
        variant.source_status !== "DISABLED" &&
        (!body.channelId || variant.channel_id === body.channelId),
    );
    if (variants.length === 0)
      return ctx.fail(404, "Aucun flux disponible pour ce match");
    const variant =
      variants.find((item) => item.healthStatus !== "DOWN") ?? variants[0];
    return respondWithPlay(
      ctx,
      decryptLocatorWithSecret(env.ENCRYPTION_KEY, variant.encryptedLocator),
      matchEcoMaxHeight,
    );
  }

  if (matchMatch && !matchMatch[2] && method === "GET") {
    const found = await matches.findMatchVariants(
      env,
      decodeURIComponent(matchMatch[1]),
    );
    if (!found) return ctx.fail(404, "Match not found");
    return ctx.json(matches.serializeMatch(env, found.match, found.variants));
  }

  if (path === "/api/epg/featured" && method === "GET")
    return ctx.json(
      await epg.epgFeatured(env, intParam(url.searchParams.get("limit"), 5, 1, 10)),
    );

  if (path === "/api/epg/range" && method === "GET") {
    return ctx.json(
      await epg.epgRange(env, {
        from: url.searchParams.get("from") ?? undefined,
        to: url.searchParams.get("to") ?? undefined,
        category: url.searchParams.get("category") ?? undefined,
      }),
    );
  }

  if (path === "/api/programmes/search" && method === "GET") {
    const q = url.searchParams.get("q");
    if (!q) return ctx.fail(400, "q est requis");
    return ctx.json(
      await epg.searchProgrammes(env, {
        q: q.slice(0, 80),
        category: url.searchParams.get("category") ?? undefined,
        limit: intParam(url.searchParams.get("limit"), 30, 1, 100),
      }),
    );
  }

  if (path === "/api/activity/heartbeat" && method === "POST") {
    const deviceId = ctx.request.headers.get("x-device-id");
    if (!deviceId?.trim())
      return ctx.fail(400, "Identifiant appareil manquant");
    const body = await readJson(ctx.request).catch(() => ({}));
    await activity.heartbeat(
      env,
      deviceId,
      typeof body.channelId === "string" ? body.channelId : undefined,
    );
    return ctx.json({ ok: true });
  }

  if (path === "/api/activity/counts" && method === "GET") {
    return ctx.json({ global: await activity.globalCount(env) });
  }

  const viewersMatch = path.match(/^\/api\/activity\/viewers\/([^/]+)$/);
  if (viewersMatch && method === "GET") {
    return ctx.json({
      count: await activity.channelCount(
        env,
        decodeURIComponent(viewersMatch[1]),
      ),
    });
  }

  if (path === "/api/access/status" && method === "GET") {
    return ctx.json(
      await access.accessStatus(
        env,
        ctx.request.headers.get("x-device-id") ?? undefined,
      ),
    );
  }

  if (path === "/api/access/redeem" && method === "POST") {
    const deviceId = ctx.request.headers.get("x-device-id");
    if (!deviceId?.trim())
      return ctx.fail(409, "Identifiant appareil manquant");
    const body = await readJson(ctx.request).catch(() => null);
    const code = typeof body?.code === "string" ? body.code : "";
    if (code.length < 4 || code.length > 64)
      return ctx.fail(400, "Code invalide");
    const result = await access.redeemCode(
      env,
      code,
      deviceId,
      ctx.request.headers.get("user-agent") ?? undefined,
      ctx.request.headers.get("cf-connecting-ip") ?? "",
    );
    if (result.status !== 200) return ctx.fail(result.status, result.message);
    return ctx.json(result.value);
  }

  // Favoris par appareil — même garde que la lecture : grant actif requis.
  if (path === "/api/favorites" && method === "GET") {
    const deviceId = ctx.request.headers.get("x-device-id");
    if (!deviceId?.trim()) return ctx.fail(400, "Identifiant appareil manquant");
    if (!(await assertGrantActive(env, deviceId)))
      return ctx.fail(403, "Un code d’accès actif est requis");
    return ctx.json(await favorites.listFavorites(env, deviceId));
  }

  const favoriteMatch = path.match(/^\/api\/favorites\/([^/]+)$/);
  if (favoriteMatch && (method === "PUT" || method === "DELETE")) {
    const deviceId = ctx.request.headers.get("x-device-id");
    if (!deviceId?.trim()) return ctx.fail(400, "Identifiant appareil manquant");
    if (!(await assertGrantActive(env, deviceId)))
      return ctx.fail(403, "Un code d’accès actif est requis");
    const channelId = decodeURIComponent(favoriteMatch[1]);
    const result =
      method === "PUT"
        ? await favorites.addFavorite(env, deviceId, channelId)
        : await favorites.removeFavorite(env, deviceId, channelId);
    if (result === null) return ctx.fail(404, "Channel not found");
    return ctx.json(result);
  }

  const ownerResponse = await handleOwnerRoute(ctx, url, path, method);
  if (ownerResponse) return ownerResponse;

  return ctx.fail(404, `Cannot ${method} ${path}`);
}

// Cron Triggers : reprise des imports en attente (toutes les 2 min), santé des
// flux (10 min), découverte de matchs (15 min), EPG complet (5 h).
export async function scheduled(event, env) {
  env.db = {
    query: (e, sql, params) => withClient(e, (client) => client.query(sql, params)),
  };
  const cron = event.cron ?? "";
  try {
    if (cron === "*/2 * * * *") {
      const resumed = await resumeQueuedImports(env);
      console.log("[cron] imports repris:", resumed);
    } else if (cron === "*/10 * * * *") {
      const key = await importKey(env.ENCRYPTION_KEY);
      console.log("[cron] health:", JSON.stringify(await scanDueVariants(env, key, Number(env.HEALTH_CHECK_BATCH_SIZE ?? 10))));
    } else if (cron === "*/15 * * * *") {
      console.log("[cron] matches:", JSON.stringify(await discoverMatches(env)));
    } else if (cron === "0 5 * * *") {
      // Purge des codes d'accès morts : révoqués, désactivés ou dont le
      // grant a expiré. Les codes jamais utilisés restent (inventaire valide).
      const purged = await env.db.query(
        env,
        `DELETE FROM "AccessCode" a WHERE a."revokedAt" IS NOT NULL OR a.active = false
         OR EXISTS (SELECT 1 FROM "DeviceGrant" g WHERE g."accessCodeId" = a.id AND g."expiresAt" <= now())`,
      );
      console.log("[cron] codes purgés:", purged.rowCount ?? 0);
      const sources = await env.db.query(env, `SELECT id FROM "Source" WHERE status <> 'DISABLED' AND (kind = 'XTREAM' OR "epgUrl" IS NOT NULL)`);
      for (const source of sources.rows) {
        await runEpgImportForSource(env, source.id).catch((error) => console.error("[cron] epg", error.message));
      }
    }
  } catch (error) {
    console.error("[cron]", cron, error instanceof Error ? error.stack ?? error.message : error);
  }
}

export default {
  async fetch(request, env, ctx) {
    const context = new Ctx(request, env, ctx);
    context.env.db = {
      query: (e, sql, params) =>
        withClient(e, (client) => client.query(sql, params)),
    };
    const url = new URL(request.url);
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    try {
      return await route(context, url);
    } catch (caught) {
      console.error(
        "[api]",
        caught instanceof Error ? (caught.stack ?? caught.message) : caught,
      );
      return context.fail(500, "Erreur interne");
    }
  },
};
