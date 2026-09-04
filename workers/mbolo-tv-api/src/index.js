import { withClient } from "./db.js";
import { decryptLocatorWithSecret, importKey } from "./crypto.js";
import * as categoriesRepo from "./categories.js";
import * as channels from "./channels.js";
import * as matches from "./matches.js";
import * as epg from "./epg.js";
import * as activity from "./activity.js";
import * as access from "./access.js";
import * as favorites from "./favorites.js";
import * as logo from "./logo.js";
import * as vod from "./vod.js";
import * as youtube from "./youtube.js";
import * as notifications from "./notifications.js";
import { selectVariant, assertGrantActive, playResponse } from "./play.js";
import { handleOwnerRoute, resumeQueuedImports, failStaleImports } from "./owner-routes.js";
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

  json(value, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(value), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...extraHeaders,
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

// ---- Éco adaptatif -------------------------------------------------------
// Le relais résidentiel porte ~1 flux par chaîne ACTIVE (mutualisation proxy),
// pas par spectateur : l'affluence se mesure donc en chaînes distinctes
// récemment heartbeattées, pas en viewers. Au-delà du seuil éco, les NOUVELLES
// sessions sont plafonnées en 480p (maxh) — les sessions en cours gardent leur
// URL, sans redémarrage de flux. Au seuil de saturation, la garde refuse
// proprement (429) plutôt que de dégrader tous les flux en même temps.
const ECO_AUTO_THRESHOLD_DEFAULT = 3;   // ≈ 2 chaînes HD saturent déjà 10 Mbps d'uplink
const ECO_AUTO_MAXH_DEFAULT = 480;
const ECO_SATURATED_THRESHOLD_DEFAULT = 8; // ≈ 8 × 1 Mbps : plafond réaliste de l'uplink
const ECO_ACTIVE_WINDOW_SECONDS = 120;  // > TTL heartbeat (60 s) : tolère un battement

function intEnv(env, name, fallback) {
  const parsed = Number.parseInt(String(env?.[name] ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ecoSettings(env) {
  return {
    ecoThreshold: intEnv(env, "ECO_AUTO_THRESHOLD", ECO_AUTO_THRESHOLD_DEFAULT),
    ecoMaxHeight: intEnv(env, "ECO_AUTO_MAXH", ECO_AUTO_MAXH_DEFAULT),
    saturatedThreshold: intEnv(env, "ECO_SATURATED_THRESHOLD", ECO_SATURATED_THRESHOLD_DEFAULT),
  };
}

// Décision de plafond pour une nouvelle session de lecture :
//   { status: 429 }            → garde de saturation (Retry-After renvoyé)
//   { maxHeight }              → session autorisée, éventuellement plafonnée
async function ecoDecision(env, explicitEco) {
  if (explicitEco) return { maxHeight: 480 };
  const { ecoThreshold, ecoMaxHeight, saturatedThreshold } = ecoSettings(env);
  const activeChannels = await activity.activeChannelCount(env, ECO_ACTIVE_WINDOW_SECONDS);
  if (saturatedThreshold > 0 && activeChannels >= saturatedThreshold)
    return { status: 429 };
  if (ecoThreshold > 0 && activeChannels >= ecoThreshold)
    return { maxHeight: ecoMaxHeight };
  return { maxHeight: undefined };
}

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
// qu'aux appareils munis d'un DeviceGrant actif (x-device-id). L'éco adaptatif
// (affluence) est évalué APRÈS les contrôles 403/404 : seules les demandes
// légitimes peuvent être plafonnées ou refusées par la garde de saturation.
async function respondWithPlay(ctx, locatorPromise, explicitEco) {
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
  const decision = await ecoDecision(ctx.env, explicitEco);
  if (decision.status === 429)
    return ctx.json(
      { message: "Trop de spectateurs simultanés, réessayez dans quelques instants.", statusCode: 429 },
      429,
      { "retry-after": "30" },
    );
  return ctx.json(await playResponse(ctx.env, providerUrl, decision.maxHeight, { qualityCap: decision.maxHeight }));
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

  // Proxy d'images (logos) : URLs signées par l'existence en base, servies
  // depuis notre domaine avec cache edge (hôtes fournisseur souvent morts).
  if (path === "/api/logo" && method === "GET")
    return logo.serveLogo(env, url.searchParams.get("url") ?? "", ctx.corsHeaders());

  const channelMatch = path.match(/^\/api\/channels\/([^/]+)(\/(epg|play))?$/);

  if (channelMatch && channelMatch[3] === "play" && method === "GET") {
    const channelId = decodeURIComponent(channelMatch[1]);
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
      url.searchParams.get("eco") === "1",
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
      url.searchParams.get("eco") === "1",
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

  // ---- VOD (films & séries) ----------------------------------------------
  // Catalogue public (visible/actif uniquement) ; lecture protégée par le
  // même mur DeviceGrant que le live. Pas d'éco adaptatif : le VOD sort en
  // direct de Cloudflare (direct=1) et ne charge pas le relais résidentiel.

  if (path === "/api/vod/categories" && method === "GET")
    return ctx.json(await vod.vodCategories(env, url.searchParams.get("kind") ?? undefined));

  // Accueil façon Netflix : rangées horizontales par catégorie + héros.
  // Placées avant vodMatch qui capterait /api/vod/rows comme un id.
  if (path === "/api/vod/rows" && method === "GET")
    return ctx.json({
      rows: await vod.vodRows(env, {
        kind: url.searchParams.get("kind") ?? undefined,
        q: url.searchParams.get("q") ?? undefined,
        rowsCount: intParam(url.searchParams.get("rows"), 8, 1, 20),
        perRow: intParam(url.searchParams.get("perRow"), 20, 1, 50),
      }),
    });

  if (path === "/api/vod/hero" && method === "GET")
    return ctx.json({ items: await vod.vodHero(env, { kind: url.searchParams.get("kind") ?? undefined }) });

  if (path === "/api/vod/favorites" && method === "GET") {
    const deviceId = ctx.request.headers.get("x-device-id");
    if (!deviceId?.trim()) return ctx.fail(400, "Identifiant appareil manquant");
    if (!(await assertGrantActive(env, deviceId)))
      return ctx.fail(403, "Un code d’accès actif est requis");
    return ctx.json({ items: await vod.listVodFavorites(env, deviceId) });
  }

  if (path === "/api/vod" && method === "GET")
    return ctx.json(
      await vod.listVodItems(env, {
        kind: url.searchParams.get("kind") ?? undefined,
        category: url.searchParams.get("category") ?? undefined,
        q: url.searchParams.get("q") ?? undefined,
        limit: intParam(url.searchParams.get("limit"), 48, 1, 100),
        offset: intParam(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
      }),
    );

  // YouTube (onglet Nollywood) : placées avant vodMatch qui capterait
  // sinon /api/vod/youtube comme un id d'item.
  if (path === "/api/vod/youtube" && method === "GET") {
    return youtube.serveYoutubeList(
      env,
      url.searchParams.get("channel") ?? "",
      url.searchParams.get("pageToken") ?? null,
      intParam(url.searchParams.get("limit"), 25, 1, 50),
      url.searchParams.get("q") ?? null,
      ctx.corsHeaders(),
    );
  }

  if (path === "/api/vod/youtube/video" && method === "GET")
    return youtube.serveYoutubeVideo(env, url.searchParams.get("id") ?? "", ctx.corsHeaders());

  const vodMatch = path.match(/^\/api\/vod\/([^/]+)(\/(episodes|play|favorite))?$/);

  if (vodMatch && !vodMatch[3] && method === "GET") {
    const item = await vod.findVodItemById(env, decodeURIComponent(vodMatch[1]));
    if (!item) return ctx.fail(404, "Item VOD introuvable");
    // Détail enrichi : synopsis + backdrop via TVmaze (cache 30 j). Non
    // bloquant : un échec renvoie la fiche sans description.
    const meta = await vod.vodMetadata(env, item.title, item.kind).catch(() => null);
    // Synopsis fournisseur prioritaire ; backdrop/genres/année viennent du secours.
    return ctx.json(vod.serializeVodItem({ ...(meta ?? {}), ...item, description: item.description ?? meta?.description ?? null, backdropUrl: meta?.backdropUrl ?? null }));
  }

  if (vodMatch && vodMatch[3] === "favorite" && (method === "PUT" || method === "DELETE")) {
    const deviceId = ctx.request.headers.get("x-device-id");
    if (!deviceId?.trim()) return ctx.fail(400, "Identifiant appareil manquant");
    if (!(await assertGrantActive(env, deviceId)))
      return ctx.fail(403, "Un code d’accès actif est requis");
    const vodItemId = decodeURIComponent(vodMatch[1]);
    const ok =
      method === "PUT"
        ? await vod.addVodFavorite(env, deviceId, vodItemId)
        : (await vod.removeVodFavorite(env, deviceId, vodItemId), true);
    if (!ok) return ctx.fail(404, "Item VOD introuvable");
    return ctx.json({ ok: true });
  }

  if (vodMatch && vodMatch[3] === "episodes" && method === "GET") {
    const item = await vod.findVodItemById(env, decodeURIComponent(vodMatch[1]));
    if (!item) return ctx.fail(404, "Item VOD introuvable");
    if (item.kind !== "SERIES") return ctx.json({ seasons: [] });
    try {
      const key = await importKey(env.ENCRYPTION_KEY);
      return ctx.json(await vod.listSeriesEpisodes(env, key, item));
    } catch {
      return ctx.fail(502, "Épisodes indisponibles pour le moment");
    }
  }

  if (vodMatch && vodMatch[3] === "play" && method === "GET") {
    const deviceId = ctx.request.headers.get("x-device-id");
    if (!(await assertGrantActive(env, deviceId)))
      return ctx.fail(403, "Un code d’accès actif est requis");
    const item = await vod.findVodItemById(env, decodeURIComponent(vodMatch[1]));
    if (!item) return ctx.fail(404, "Item VOD introuvable");
    let providerUrl;
    try {
      if (item.kind === "SERIES") {
        const season = intParam(url.searchParams.get("s"), 0, 0, 200);
        const episode = intParam(url.searchParams.get("e"), 0, 0, 5000);
        providerUrl = await vod.resolveVodProviderUrl(env, await importKey(env.ENCRYPTION_KEY), item, { season, episode });
        if (!providerUrl) return ctx.fail(404, "Épisode introuvable");
      } else {
        providerUrl = await vod.resolveVodProviderUrl(env, await importKey(env.ENCRYPTION_KEY), item);
      }
    } catch {
      return ctx.fail(502, "Lecture indisponible pour le moment");
    }
    // VOD : sortie directe Cloudflare (le film ne passe pas par la box).
    return ctx.json(await playResponse(env, providerUrl, undefined, { direct: true }));
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

  // Notifications : abonnements push et rappels par appareil, annonces lues.
  // Mêmes routes que l'API NestJS ; l'envoi effectif est fait par son cron.
  if (path === "/api/push/subscribe" && (method === "POST" || method === "DELETE")) {
    const deviceId = ctx.request.headers.get("x-device-id");
    if (!deviceId?.trim()) return ctx.fail(400, "Identifiant appareil manquant");
    if (!(await assertGrantActive(env, deviceId)))
      return ctx.fail(403, "Un code d’accès actif est requis");
    if (method === "DELETE") return ctx.json(await notifications.unsubscribe(env, deviceId));
    const subscribed = await notifications.subscribe(env, deviceId, await ctx.readJson().catch(() => null));
    if (!subscribed) return ctx.fail(400, "Abonnement invalide");
    return ctx.json(subscribed);
  }

  if (path === "/api/reminders" && (method === "GET" || method === "POST")) {
    const deviceId = ctx.request.headers.get("x-device-id");
    if (!deviceId?.trim()) return ctx.fail(400, "Identifiant appareil manquant");
    if (!(await assertGrantActive(env, deviceId)))
      return ctx.fail(403, "Un code d’accès actif est requis");
    if (method === "GET") return ctx.json(await notifications.listReminders(env, deviceId));
    const added = await notifications.addReminder(env, deviceId, await ctx.readJson().catch(() => null));
    if (!added) return ctx.fail(400, "Rappel invalide");
    return ctx.json(added);
  }

  const reminderMatch = path.match(/^\/api\/reminders\/([^/]+)$/);
  if (reminderMatch && method === "DELETE") {
    const deviceId = ctx.request.headers.get("x-device-id");
    if (!deviceId?.trim()) return ctx.fail(400, "Identifiant appareil manquant");
    if (!(await assertGrantActive(env, deviceId)))
      return ctx.fail(403, "Un code d’accès actif est requis");
    return ctx.json(await notifications.removeReminder(env, deviceId, decodeURIComponent(reminderMatch[1])));
  }

  if (path === "/api/announcements" && method === "GET") {
    const deviceId = ctx.request.headers.get("x-device-id");
    if (!deviceId?.trim()) return ctx.fail(400, "Identifiant appareil manquant");
    if (!(await assertGrantActive(env, deviceId)))
      return ctx.fail(403, "Un code d’accès actif est requis");
    return ctx.json(await notifications.listPublished(env));
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
      const orphaned = await failStaleImports(env);
      if (orphaned > 0) console.log("[cron] imports orphelins marqués FAILED:", orphaned);
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
  async scheduled(event, env, context) {
    context.waitUntil(scheduled(event, env));
  },
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
