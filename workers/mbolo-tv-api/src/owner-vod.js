// Catalogue VOD de la console : miroir SQL brut de apps/api/src/modules/
// owner-console/owner-vod.controller.ts (mêmes routes /api/owner/vod/*, mêmes
// réponses). Dossiers en arbre + règles categoryTitle + affectations manuelles
// + sources YouTube rattachées.
import { slugify } from './normalize.js';
import { checkEmbedPage, checkSource, SUPPORTED_HOSTS } from './extractors/index.js';
import { previewFiche, readCachedPreview, serveFichePreview } from './scrapers/index.js';
import { resyncExternalMeta } from './external.js';

const KINDS = new Set(['MOVIE', 'SERIES', 'BOTH']);
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
// Vérifications inline max par publication : au-delà, les lecteurs partent en
// UNKNOWN pour le cron (plafond de sous-requêtes Cloudflare par invocation).
const MAX_INLINE_VERIFY = 12;

function normKey(title) {
  return String(title).trim().toLowerCase();
}

async function uniqueFolderSlug(env, name) {
  let slug = slugify(name);
  if (!slug) slug = `dossier-${Date.now()}`;
  let candidate = slug;
  for (let suffix = 2; ; suffix += 1) {
    const exists = await env.db.query(env, `SELECT 1 FROM "VodFolder" WHERE slug = $1 LIMIT 1`, [candidate]);
    if (exists.rows.length === 0) break;
    candidate = `${slug}-${suffix}`;
  }
  return candidate;
}

async function buildOwnerVodCatalog(ctx, owner) {
  const { env } = ctx;
  const [folders, rules, sources, manual, keyCounts, overlaps, unsorted] = await Promise.all([
    env.db.query(env, `SELECT id, slug, name, kind, "parentId", "isVisible", "sortOrder" FROM "VodFolder" ORDER BY "sortOrder" ASC, name ASC`),
    env.db.query(env, `SELECT "folderId", "categoryKey", "categoryTitle" FROM "VodFolderRule" ORDER BY "categoryTitle" ASC`),
    env.db.query(env, `SELECT id, "folderId", "channelId", label, "isActive", "sortOrder" FROM "VodYoutubeSource" ORDER BY "sortOrder" ASC, "createdAt" ASC`),
    env.db.query(
      env,
      `SELECT fi."folderId", COUNT(*)::int AS count FROM "VodFolderItem" fi JOIN "VodItem" i ON i.id = fi."vodItemId" JOIN "Source" s ON s.id = i."sourceId"
       WHERE i."isActive" AND s."ownerId" = $1 GROUP BY fi."folderId"`,
      [owner.userId],
    ),
    env.db.query(
      env,
      `SELECT i."categoryKey", COUNT(*)::int AS count FROM "VodItem" i JOIN "Source" s ON s.id = i."sourceId"
       WHERE i."isActive" AND s."ownerId" = $1 AND i."categoryKey" IS NOT NULL GROUP BY i."categoryKey"`,
      [owner.userId],
    ),
    env.db.query(
      env,
      `SELECT fi."folderId", COUNT(*)::int AS count FROM "VodFolderItem" fi
       JOIN "VodItem" i ON i.id = fi."vodItemId"
       JOIN "VodFolderRule" r ON r."folderId" = fi."folderId" AND r."categoryKey" = i."categoryKey"
       JOIN "Source" s ON s.id = i."sourceId"
       WHERE i."isActive" AND s."ownerId" = $1 GROUP BY fi."folderId"`,
      [owner.userId],
    ),
    env.db.query(
      env,
      `SELECT COUNT(*)::int AS count FROM "VodItem" i JOIN "Source" s ON s.id = i."sourceId"
       WHERE i."isActive" AND s."ownerId" = $1
         AND NOT EXISTS (SELECT 1 FROM "VodFolderItem" fi WHERE fi."vodItemId" = i.id)
         AND (i."categoryKey" IS NULL OR NOT EXISTS (SELECT 1 FROM "VodFolderRule" r WHERE r."categoryKey" = i."categoryKey"))`,
      [owner.userId],
    ),
  ]);

  const rulesByFolder = new Map();
  for (const rule of rules.rows) {
    const list = rulesByFolder.get(rule.folderId) ?? [];
    list.push({ categoryKey: rule.categoryKey, categoryTitle: rule.categoryTitle });
    rulesByFolder.set(rule.folderId, list);
  }
  const sourcesByFolder = new Map();
  for (const source of sources.rows) {
    const list = sourcesByFolder.get(source.folderId) ?? [];
    list.push({ id: source.id, folderId: source.folderId, channelId: source.channelId, label: source.label ?? null, isActive: source.isActive, sortOrder: source.sortOrder });
    sourcesByFolder.set(source.folderId, list);
  }
  const manualByFolder = new Map(manual.rows.map((row) => [row.folderId, row.count]));
  const countByKey = new Map(keyCounts.rows.map((row) => [row.categoryKey, row.count]));
  const overlapByFolder = new Map(overlaps.rows.map((row) => [row.folderId, row.count]));

  const byId = new Map(folders.rows.map((row) => [row.id, row]));
  const effective = new Map();
  const visiting = new Set();
  const computeEffective = (id) => {
    const cached = effective.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) { effective.set(id, false); return false; }
    visiting.add(id);
    const node = byId.get(id);
    if (!node) { visiting.delete(id); return false; }
    const parentOk = node.parentId == null || !byId.has(node.parentId) ? true : computeEffective(node.parentId);
    visiting.delete(id);
    const result = node.isVisible && parentOk;
    effective.set(id, result);
    return result;
  };
  folders.rows.forEach((row) => computeEffective(row.id));

  const childrenByParent = new Map();
  for (const row of folders.rows) {
    const bucket = childrenByParent.get(row.parentId) ?? [];
    bucket.push(row);
    childrenByParent.set(row.parentId, bucket);
  }
  const buildVisiting = new Set();
  const buildNode = (row) => {
    if (buildVisiting.has(row.id)) return { id: row.id, slug: row.slug, name: row.name, kind: 'BOTH', parentId: row.parentId ?? null, isVisible: row.isVisible, effectiveVisible: effective.get(row.id) ?? false, sortOrder: row.sortOrder, itemCount: 0, rules: [], youtubeSources: [], children: [] };
    buildVisiting.add(row.id);
    const folderRules = rulesByFolder.get(row.id) ?? [];
    const fromRules = folderRules.reduce((sum, rule) => sum + (countByKey.get(rule.categoryKey) ?? 0), 0);
    const itemCount = (manualByFolder.get(row.id) ?? 0) + fromRules - (overlapByFolder.get(row.id) ?? 0);
    const children = (childrenByParent.get(row.id) ?? []).map(buildNode);
    buildVisiting.delete(row.id);
    return {
      id: row.id, slug: row.slug, name: row.name, kind: row.kind, parentId: row.parentId ?? null,
      isVisible: row.isVisible, effectiveVisible: effective.get(row.id) ?? false, sortOrder: row.sortOrder,
      itemCount: Math.max(0, itemCount), rules: folderRules, youtubeSources: sourcesByFolder.get(row.id) ?? [], children,
    };
  };
  const roots = folders.rows.filter((row) => row.parentId == null || !byId.has(row.parentId));
  return { folders: roots.map(buildNode), unsortedCount: unsorted.rows[0]?.count ?? 0 };
}

export async function handleOwnerVodRoute(ctx, url, path, method, owner, audit) {
  const { env } = ctx;
  const dec = (value) => decodeURIComponent(value);

  if (path === '/api/owner/vod/catalog' && method === 'GET') return ctx.json(await buildOwnerVodCatalog(ctx, owner));

  if (path === '/api/owner/vod/catalog/items' && method === 'GET') {
    const folderId = url.searchParams.get('folderId');
    const q = url.searchParams.get('q');
    const kind = url.searchParams.get('kind');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
    const offset = Number(url.searchParams.get('offset') ?? 0) || 0;
    const params = [owner.userId];
    const conditions = [`i."isActive"`, `s."ownerId" = $1`];
    let folderKeys = [];
    if (folderId === 'none') {
      conditions.push(`NOT EXISTS (SELECT 1 FROM "VodFolderItem" fi WHERE fi."vodItemId" = i.id)`);
      conditions.push(`(i."categoryKey" IS NULL OR NOT EXISTS (SELECT 1 FROM "VodFolderRule" r WHERE r."categoryKey" = i."categoryKey"))`);
    } else if (folderId) {
      const folder = await env.db.query(env, `SELECT id FROM "VodFolder" WHERE id = $1`, [folderId]);
      if (folder.rows.length === 0) return ctx.fail(404, 'Dossier introuvable');
      const rules = await env.db.query(env, `SELECT "categoryKey" FROM "VodFolderRule" WHERE "folderId" = $1`, [folderId]);
      folderKeys = rules.rows.map((row) => row.categoryKey);
      params.push(folderId);
      const n = params.length;
      const or = [`EXISTS (SELECT 1 FROM "VodFolderItem" fi WHERE fi."vodItemId" = i.id AND fi."folderId" = $${n})`];
      if (folderKeys.length > 0) { params.push(folderKeys); or.push(`i."categoryKey" = ANY($${params.length}::text[])`); }
      conditions.push(`(${or.join(' OR ')})`);
    }
    if (kind === 'MOVIE' || kind === 'SERIES') { params.push(kind); conditions.push(`i.kind = $${params.length}`); }
    if (q) { params.push(`%${q}%`); conditions.push(`i.title ILIKE $${params.length}`); }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const [rows, counts] = await Promise.all([
      env.db.query(
        env,
        `SELECT i.id, i.kind, i.title, i."posterUrl", i."categoryTitle", i."isVisible", i."categoryKey" FROM "VodItem" i JOIN "Source" s ON s.id = i."sourceId"
         ${where} ORDER BY i.title ASC, i.id ASC LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      env.db.query(env, `SELECT COUNT(*)::int AS total FROM "VodItem" i JOIN "Source" s ON s.id = i."sourceId" ${where}`, params),
    ]);
    const ids = rows.rows.map((row) => row.id);
    const links = ids.length > 0
      ? await env.db.query(env, `SELECT "vodItemId", "folderId" FROM "VodFolderItem" WHERE "vodItemId" = ANY($1::text[])`, [ids])
      : { rows: [] };
    const foldersByItem = new Map();
    for (const link of links.rows) {
      const list = foldersByItem.get(link.vodItemId) ?? [];
      list.push(link.folderId);
      foldersByItem.set(link.vodItemId, list);
    }
    const keySet = new Set(folderKeys);
    return ctx.json({
      items: rows.rows.map((row) => {
        const itemFolders = foldersByItem.get(row.id) ?? [];
        const manual = folderId && folderId !== 'none' ? itemFolders.includes(folderId) : itemFolders.length > 0;
        const byRule = !!folderId && folderId !== 'none' && row.categoryKey != null && keySet.has(row.categoryKey);
        const matchedBy = manual && byRule ? 'BOTH' : byRule ? 'RULE' : 'MANUAL';
        return { id: row.id, kind: row.kind, title: row.title, posterUrl: row.posterUrl ?? null, categoryTitle: row.categoryTitle ?? null, isVisible: row.isVisible, folderIds: itemFolders, matchedBy };
      }),
      total: counts.rows[0]?.total ?? 0,
    });
  }

  if (path === '/api/owner/vod/categories/available' && method === 'GET') {
    const kind = url.searchParams.get('kind');
    const params = [owner.userId];
    let kindFilter = '';
    if (kind === 'MOVIE' || kind === 'SERIES') { params.push(kind); kindFilter = `AND i.kind = $2`; }
    const rows = await env.db.query(
      env,
      `SELECT i."categoryKey", MIN(i."categoryTitle") AS title, COUNT(*)::int AS count
       FROM "VodItem" i JOIN "Source" s ON s.id = i."sourceId"
       WHERE i."isActive" AND s."ownerId" = $1 AND i."categoryKey" IS NOT NULL ${kindFilter}
       GROUP BY i."categoryKey" ORDER BY count DESC LIMIT 300`,
      params,
    );
    return ctx.json(rows.rows.map((row) => ({ key: row.categoryKey, title: row.title ?? row.categoryKey, count: row.count })));
  }

  if (path === '/api/owner/vod/folders' && method === 'POST') {
    const body = await ctx.readJson().catch(() => ({}));
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 120) return ctx.fail(400, 'Validation failed');
    const kind = KINDS.has(body?.kind) ? body.kind : 'BOTH';
    const parentId = body?.parentId ?? null;
    if (parentId) {
      const parent = await env.db.query(env, `SELECT id FROM "VodFolder" WHERE id = $1`, [parentId]);
      if (parent.rows.length === 0) return ctx.fail(400, 'Parent invalide');
    }
    const slug = await uniqueFolderSlug(env, name);
    const maxRow = await env.db.query(env, `SELECT COALESCE(MAX("sortOrder"), -1)::int AS max FROM "VodFolder"`);
    const id = crypto.randomUUID();
    await env.db.query(
      env,
      `INSERT INTO "VodFolder" (id, slug, name, kind, "sortOrder", "isVisible", "parentId") VALUES ($1,$2,$3,$4,$5,true,$6)`,
      [id, slug, name, kind, maxRow.rows[0].max + 1, parentId],
    );
    await audit(ctx, owner.userId, 'vod.folder_create', 'vod_folder', id, { name, parentId });
    return ctx.json(await buildOwnerVodCatalog(ctx, owner));
  }

  const folderPatch = path.match(/^\/api\/owner\/vod\/folders\/([^/]+)$/);
  if (folderPatch && method === 'PATCH') {
    const id = dec(folderPatch[1]);
    const body = await ctx.readJson().catch(() => ({}));
    const folderRows = await env.db.query(env, `SELECT * FROM "VodFolder" WHERE id = $1`, [id]);
    const folder = folderRows.rows[0];
    if (!folder) return ctx.fail(404, 'Dossier introuvable');
    const updates = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 120);
      if (!name) return ctx.fail(400, 'Validation failed');
      updates.name = name;
    }
    if (body.kind !== undefined) {
      if (!KINDS.has(body.kind)) return ctx.fail(400, 'Validation failed');
      updates.kind = body.kind;
    }
    if (body.isVisible !== undefined) updates.isVisible = Boolean(body.isVisible);
    if (body.sortOrder !== undefined) updates.sortOrder = Number(body.sortOrder) || 0;
    if (body.parentId !== undefined) {
      const parentId = body.parentId || null;
      if (parentId === id) return ctx.fail(400, 'Un parent ne peut pas être lui-même');
      if (parentId) {
        let cursor = parentId;
        while (cursor) {
          if (cursor === id) return ctx.fail(400, 'Cycle détecté dans l’arbre');
          const parentRow = await env.db.query(env, `SELECT "parentId" FROM "VodFolder" WHERE id = $1`, [cursor]);
          cursor = parentRow.rows[0]?.parentId ?? null;
        }
      }
      updates.parentId = parentId;
    }
    const keys = Object.keys(updates);
    if (keys.length === 0) return ctx.fail(400, 'Aucune modification');
    const targetParent = updates.parentId !== undefined ? updates.parentId : folder.parentId;
    if (updates.sortOrder !== undefined) {
      // Réordonnancement 1-based de toute la fratrie (miroir de la transaction Nest).
      const siblings = await env.db.query(
        env,
        `SELECT id FROM "VodFolder" WHERE ${targetParent == null ? '"parentId" IS NULL' : '"parentId" = $2'} AND id <> $1 ORDER BY "sortOrder" ASC, name ASC`,
        targetParent == null ? [id] : [id, targetParent],
      );
      const ordered = siblings.rows.map((row) => row.id);
      const clamped = Math.max(0, Math.min(updates.sortOrder, ordered.length));
      ordered.splice(clamped, 0, id);
      const { parentId: _omit, ...own } = updates;
      for (let index = 0; index < ordered.length; index += 1) {
        const folderId = ordered[index];
        if (folderId === id && Object.keys(own).length > 0) {
          const assignments = Object.keys(own).map((key, position) => `"${key}" = $${position + 3}`).join(', ');
          await env.db.query(env, `UPDATE "VodFolder" SET "sortOrder" = $2, ${assignments} WHERE id = $1`, [folderId, index + 1, ...Object.values(own)]);
        } else {
          await env.db.query(env, `UPDATE "VodFolder" SET "sortOrder" = $2 WHERE id = $1`, [folderId, index + 1]);
        }
      }
      if (updates.parentId !== undefined) await env.db.query(env, `UPDATE "VodFolder" SET "parentId" = $2 WHERE id = $1`, [id, updates.parentId]);
    } else {
      const assignments = keys.map((key, position) => `"${key}" = $${position + 2}`).join(', ');
      await env.db.query(env, `UPDATE "VodFolder" SET ${assignments} WHERE id = $1`, [id, ...Object.values(updates)]);
      if (updates.parentId !== undefined && updates.parentId !== folder.parentId) {
        const maxRow = await env.db.query(env, `SELECT COALESCE(MAX("sortOrder"), 0)::int AS max FROM "VodFolder" WHERE ${updates.parentId == null ? '"parentId" IS NULL' : '"parentId" = $1'}`, updates.parentId == null ? [] : [updates.parentId]);
        await env.db.query(env, `UPDATE "VodFolder" SET "sortOrder" = $2 WHERE id = $1`, [id, maxRow.rows[0].max + 1]);
      }
    }
    await audit(ctx, owner.userId, 'vod.folder_update', 'vod_folder', id, updates);
    return ctx.json(await buildOwnerVodCatalog(ctx, owner));
  }

  if (folderPatch && method === 'DELETE') {
    const id = dec(folderPatch[1]);
    const rows = await env.db.query(env, `SELECT id, "parentId", name FROM "VodFolder" WHERE id = $1`, [id]);
    const folder = rows.rows[0];
    if (!folder) return ctx.fail(404, 'Dossier introuvable');
    // Les sous-dossiers remontent d'un cran ; règles/affectations/sources
    // tombent en cascade (FK ON DELETE CASCADE) → items « sans dossier ».
    await env.db.query(env, `UPDATE "VodFolder" SET "parentId" = $2 WHERE "parentId" = $1`, [id, folder.parentId]);
    await env.db.query(env, `DELETE FROM "VodFolder" WHERE id = $1`, [id]);
    await audit(ctx, owner.userId, 'vod.folder_delete', 'vod_folder', id, { name: folder.name });
    return ctx.json(await buildOwnerVodCatalog(ctx, owner));
  }

  const rulesPut = path.match(/^\/api\/owner\/vod\/folders\/([^/]+)\/rules$/);
  if (rulesPut && method === 'PUT') {
    const id = dec(rulesPut[1]);
    const body = await ctx.readJson().catch(() => null);
    const titles = Array.isArray(body?.categoryTitles) ? body.categoryTitles.filter((value) => typeof value === 'string') : null;
    if (!titles || titles.length > 200) return ctx.fail(400, 'Validation failed');
    const folder = await env.db.query(env, `SELECT id FROM "VodFolder" WHERE id = $1`, [id]);
    if (folder.rows.length === 0) return ctx.fail(404, 'Dossier introuvable');
    const seen = new Map();
    for (const title of titles) {
      const clean = String(title).trim();
      if (clean && !seen.has(normKey(clean))) seen.set(normKey(clean), clean.slice(0, 160));
    }
    await env.db.query(env, `DELETE FROM "VodFolderRule" WHERE "folderId" = $1`, [id]);
    if (seen.size > 0) {
      const values = [];
      const params = [];
      let index = 1;
      for (const [key, title] of seen) {
        values.push(`($${index}::text, $${index + 1}::text, $${index + 2}::text, $${index + 3}::text)`);
        params.push(crypto.randomUUID(), id, key, title);
        index += 4;
      }
      await env.db.query(env, `INSERT INTO "VodFolderRule" (id, "folderId", "categoryKey", "categoryTitle") VALUES ${values.join(', ')}`, params);
    }
    await audit(ctx, owner.userId, 'vod.folder_rules', 'vod_folder', id, { count: seen.size });
    return ctx.json(await buildOwnerVodCatalog(ctx, owner));
  }

  const itemsPost = path.match(/^\/api\/owner\/vod\/folders\/([^/]+)\/items$/);
  if (itemsPost && method === 'POST') {
    const id = dec(itemsPost[1]);
    const body = await ctx.readJson().catch(() => null);
    const itemIds = Array.isArray(body?.itemIds) ? body.itemIds.filter((value) => typeof value === 'string').slice(0, 200) : [];
    if (itemIds.length === 0) return ctx.fail(400, 'Aucun titre sélectionné');
    const folder = await env.db.query(env, `SELECT id FROM "VodFolder" WHERE id = $1`, [id]);
    if (folder.rows.length === 0) return ctx.fail(404, 'Dossier introuvable');
    const added = await env.db.query(
      env,
      `INSERT INTO "VodFolderItem" ("folderId", "vodItemId")
       SELECT $1, i.id FROM "VodItem" i JOIN "Source" s ON s.id = i."sourceId"
       WHERE i.id = ANY($2::text[]) AND i."isActive" AND s."ownerId" = $3
       ON CONFLICT DO NOTHING`,
      [id, itemIds, owner.userId],
    );
    await audit(ctx, owner.userId, 'vod.item_assign', 'vod_folder', id, { requested: itemIds.length, added: added.rowCount });
    return ctx.json({ added: added.rowCount });
  }

  const itemDelete = path.match(/^\/api\/owner\/vod\/folders\/([^/]+)\/items\/([^/]+)$/);
  if (itemDelete && method === 'DELETE') {
    const removed = await env.db.query(env, `DELETE FROM "VodFolderItem" WHERE "folderId" = $1 AND "vodItemId" = $2 RETURNING "vodItemId"`, [dec(itemDelete[1]), dec(itemDelete[2])]);
    if (removed.rows.length === 0) return ctx.fail(404, 'Affectation introuvable');
    await audit(ctx, owner.userId, 'vod.item_unassign', 'vod_folder', dec(itemDelete[1]), { itemId: removed.rows[0].vodItemId });
    return new Response(null, { status: 204, headers: ctx.corsHeaders() });
  }

  const itemPatch = path.match(/^\/api\/owner\/vod\/items\/([^/]+)$/);
  if (itemPatch && method === 'PATCH') {
    const id = dec(itemPatch[1]);
    const body = await ctx.readJson().catch(() => null);
    const folderIds = Array.isArray(body?.folderIds) ? Array.from(new Set(body.folderIds.filter((value) => typeof value === 'string'))).slice(0, 20) : null;
    if (!folderIds) return ctx.fail(400, 'Validation failed');
    const itemRows = await env.db.query(
      env,
      `SELECT i.id, i.kind, i.title, i."posterUrl", i."categoryTitle", i."isVisible" FROM "VodItem" i JOIN "Source" s ON s.id = i."sourceId" WHERE i.id = $1 AND s."ownerId" = $2`,
      [id, owner.userId],
    );
    const item = itemRows.rows[0];
    if (!item) return ctx.fail(404, 'Titre introuvable');
    if (folderIds.length > 0) {
      const found = await env.db.query(env, `SELECT COUNT(*)::int AS count FROM "VodFolder" WHERE id = ANY($1::text[])`, [folderIds]);
      if (found.rows[0].count !== folderIds.length) return ctx.fail(400, 'Un des dossiers est introuvable');
    }
    await env.db.query(env, `DELETE FROM "VodFolderItem" WHERE "vodItemId" = $1`, [id]);
    if (folderIds.length > 0) {
      const values = [];
      const params = [];
      folderIds.forEach((folderId, position) => {
        values.push(`($${position * 2 + 1}::text, $${position * 2 + 2}::text)`);
        params.push(folderId, id);
      });
      await env.db.query(env, `INSERT INTO "VodFolderItem" ("folderId", "vodItemId") VALUES ${values.join(', ')} ON CONFLICT DO NOTHING`, params);
    }
    let isVisible = item.isVisible;
    if (typeof body?.isVisible === 'boolean') {
      isVisible = body.isVisible;
      await env.db.query(env, `UPDATE "VodItem" SET "isVisible" = $2 WHERE id = $1`, [id, isVisible]);
    }
    await audit(ctx, owner.userId, 'vod.item_assign', 'vod_item', id, { folderIds });
    return ctx.json({ id: item.id, kind: item.kind, title: item.title, posterUrl: item.posterUrl ?? null, categoryTitle: item.categoryTitle ?? null, isVisible, folderIds, matchedBy: 'MANUAL' });
  }

  const youtubeList = path.match(/^\/api\/owner\/vod\/folders\/([^/]+)\/youtube$/);
  if (youtubeList && method === 'GET') {
    const id = dec(youtubeList[1]);
    const folder = await env.db.query(env, `SELECT id FROM "VodFolder" WHERE id = $1`, [id]);
    if (folder.rows.length === 0) return ctx.fail(404, 'Dossier introuvable');
    const rows = await env.db.query(env, `SELECT id, "folderId", "channelId", label, "isActive", "sortOrder" FROM "VodYoutubeSource" WHERE "folderId" = $1 ORDER BY "sortOrder" ASC, "createdAt" ASC`, [id]);
    return ctx.json({ items: rows.rows.map((row) => ({ ...row, label: row.label ?? null })) });
  }

  if (youtubeList && method === 'POST') {
    const id = dec(youtubeList[1]);
    const body = await ctx.readJson().catch(() => ({}));
    const channelId = typeof body?.channelId === 'string' ? body.channelId.trim() : '';
    if (!CHANNEL_ID_RE.test(channelId)) return ctx.fail(400, 'Identifiant de chaîne YouTube invalide (UC…)');
    const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null;
    const folder = await env.db.query(env, `SELECT id FROM "VodFolder" WHERE id = $1`, [id]);
    if (folder.rows.length === 0) return ctx.fail(404, 'Dossier introuvable');
    const existing = await env.db.query(env, `SELECT COUNT(*)::int AS count FROM "VodYoutubeSource" WHERE "folderId" = $1`, [id]);
    if (existing.rows[0].count >= 10) return ctx.fail(400, 'Maximum 10 sources YouTube par dossier (quota API)');
    const dupe = await env.db.query(env, `SELECT id FROM "VodYoutubeSource" WHERE "folderId" = $1 AND "channelId" = $2`, [id, channelId]);
    if (dupe.rows.length > 0) return ctx.fail(400, 'Cette chaîne est déjà rattachée à ce dossier');
    const sourceId = crypto.randomUUID();
    await env.db.query(env, `INSERT INTO "VodYoutubeSource" (id, "folderId", "channelId", label, "isActive", "sortOrder") VALUES ($1,$2,$3,$4,true,$5)`, [sourceId, id, channelId, label, existing.rows[0].count + 1]);
    await audit(ctx, owner.userId, 'vod.youtube_create', 'vod_youtube_source', sourceId, { folderId: id, channelId });
    return ctx.json(await buildOwnerVodCatalog(ctx, owner));
  }

  const youtubePatch = path.match(/^\/api\/owner\/vod\/youtube\/([^/]+)$/);
  if (youtubePatch && method === 'PATCH') {
    const id = dec(youtubePatch[1]);
    const body = await ctx.readJson().catch(() => ({}));
    const sourceRows = await env.db.query(env, `SELECT * FROM "VodYoutubeSource" WHERE id = $1`, [id]);
    const source = sourceRows.rows[0];
    if (!source) return ctx.fail(404, 'Source YouTube introuvable');
    const updates = {};
    if (body.label !== undefined) updates.label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null;
    if (body.isActive !== undefined) updates.isActive = Boolean(body.isActive);
    if (body.sortOrder !== undefined) updates.sortOrder = Number(body.sortOrder) || 0;
    const keys = Object.keys(updates);
    if (keys.length === 0) return ctx.fail(400, 'Aucune modification');
    if (updates.sortOrder !== undefined) {
      const siblings = await env.db.query(env, `SELECT id FROM "VodYoutubeSource" WHERE "folderId" = $2 AND id <> $1 ORDER BY "sortOrder" ASC, "createdAt" ASC`, [id, source.folderId]);
      const ordered = siblings.rows.map((row) => row.id);
      const clamped = Math.max(0, Math.min(updates.sortOrder, ordered.length));
      ordered.splice(clamped, 0, id);
      const { sortOrder: _omit, ...own } = updates;
      for (let index = 0; index < ordered.length; index += 1) {
        const sourceId = ordered[index];
        if (sourceId === id && Object.keys(own).length > 0) {
          const assignments = Object.keys(own).map((key, position) => `"${key}" = $${position + 3}`).join(', ');
          await env.db.query(env, `UPDATE "VodYoutubeSource" SET "sortOrder" = $2, ${assignments} WHERE id = $1`, [sourceId, index + 1, ...Object.values(own)]);
        } else {
          await env.db.query(env, `UPDATE "VodYoutubeSource" SET "sortOrder" = $2 WHERE id = $1`, [sourceId, index + 1]);
        }
      }
    } else {
      const assignments = keys.map((key, position) => `"${key}" = $${position + 2}`).join(', ');
      await env.db.query(env, `UPDATE "VodYoutubeSource" SET ${assignments} WHERE id = $1`, [id, ...Object.values(updates)]);
    }
    await audit(ctx, owner.userId, 'vod.youtube_update', 'vod_youtube_source', id, updates);
    return ctx.json(await buildOwnerVodCatalog(ctx, owner));
  }

  if (youtubePatch && method === 'DELETE') {
    const id = dec(youtubePatch[1]);
    const sourceRows = await env.db.query(env, `SELECT id, "folderId", "channelId" FROM "VodYoutubeSource" WHERE id = $1`, [id]);
    if (sourceRows.rows.length === 0) return ctx.fail(404, 'Source YouTube introuvable');
    await env.db.query(env, `DELETE FROM "VodYoutubeSource" WHERE id = $1`, [id]);
    await audit(ctx, owner.userId, 'vod.youtube_delete', 'vod_youtube_source', id, { folderId: sourceRows.rows[0].folderId, channelId: sourceRows.rows[0].channelId });
    return ctx.json(await buildOwnerVodCatalog(ctx, owner));
  }

  // ---- Titres externes (lecteurs tiers) ----
  // Aperçu d'import depuis une fiche (French Stream, …), sans écriture.
  if (path === '/api/owner/vod/external/preview' && method === 'GET') {
    return serveFichePreview(env, url.searchParams.get('url') ?? '', ctx.corsHeaders());
  }

  // Publication : scrape la fiche, vérifie chaque lecteur retenu AVANT toute
  // écriture (pas de titre vide), puis crée le titre (dédupe site+siteRef).
  // - hosts à extracteur : probe complet (embed + handshake + CDN) ;
  // - autres hosts : repli iframe (page embed 200 = OK), lus en iframe côté
  //   lecteur en attendant leur extracteur. Les morts sont rejetés avec motif
  //   (+ détail relais/direct) — jamais de catalogue pourri.
  // Budget sous-requêtes : la console envoie players[] (host+embedUrl) déjà
  // affichés ; le serveur les VALIDE contre un re-scrape (anti-SSRF : seuls
  // les embeds de la fiche sont vérifiables) au lieu de re-suivre les
  // wrappers. Vérification inline plafonnée, le reste part en UNKNOWN pour
  // le cron — un publish ne doit jamais heurter le plafond CF.
  if (path === '/api/owner/vod/external/publish' && method === 'POST') {
    const body = await ctx.readJson().catch(() => ({}));
    const ficheUrl = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!ficheUrl) return ctx.fail(400, 'URL de fiche manquante');
    const hasClientPlayers = Array.isArray(body?.players) && body.players.length > 0;
    // Cache de l'aperçu (5 min) : la console vient de l'afficher, inutile de
    // re-scraper fiche + wrappers (~20 sous-requêtes). Re-scrape sinon.
    let preview = hasClientPlayers ? await readCachedPreview(env, ficheUrl) : null;
    if (!preview) {
      try {
        preview = await previewFiche(env, ficheUrl);
      } catch (error) {
        return ctx.fail(error instanceof Error && typeof error.status === 'number' ? error.status : 502, error instanceof Error ? error.message : 'Fiche illisible');
      }
    }
    // Candidats : players[] du client validés contre l'aperçu (sécurité),
    // repli legacy hosts[].
    const previewMap = new Map(preview.players.map((player) => [`${player.host}|${player.embedUrl}`, player]));
    let candidates;
    if (hasClientPlayers) {
      candidates = [];
      for (const entry of body.players.slice(0, 24)) {
        const host = String(entry?.host ?? '').toLowerCase();
        const embedUrl = typeof entry?.embedUrl === 'string' ? entry.embedUrl : '';
        const found = previewMap.get(`${host}|${embedUrl}`);
        if (found) candidates.push(found);
      }
    } else {
      const wanted = Array.isArray(body?.hosts) && body.hosts.length > 0
        ? new Set(body.hosts.map((host) => String(host).toLowerCase()))
        : null;
      candidates = preview.players.filter((player) => !wanted || wanted.has(player.host)).slice(0, 24);
    }
    const seen = candidates.length;
    if (seen === 0) return ctx.fail(400, 'Aucun lecteur retenu sur cette fiche');
    // Phase 1 — vérification seule (aucune écriture), plafonnée : le surplus
    // part en UNKNOWN (lastCheckedAt NULL → prioritaire au prochain cron).
    // Iframe : seul un 404/410 (mort certaine) rejette — 403/timeout (mur
    // anti-bot, pas preuve de mort ; la lecture aura lieu dans le navigateur
    // de l'utilisateur) part en UNKNOWN.
    const verified = [];
    const pending = [];
    const rejected = [];
    for (const player of candidates) {
      if (verified.length + rejected.length >= MAX_INLINE_VERIFY) {
        pending.push(player);
        continue;
      }
      if (SUPPORTED_HOSTS.includes(player.host)) {
        const check = await checkSource(env, player.host, player.finalUrl ?? player.embedUrl);
        if (!check.ok) {
          rejected.push({ host: player.host, reason: check.message, detail: check.detail ?? null });
          continue;
        }
        verified.push({ player, mode: 'direct' });
      } else {
        const check = await checkEmbedPage(env, player.embedUrl);
        if (!check.ok && (check.code === 'DEAD' || check.code === 'INVALID' || check.status === 400)) {
          rejected.push({ host: player.host, reason: `Iframe : ${check.message}`, detail: check.detail ?? null });
          continue;
        }
        if (!check.ok) {
          // Mur anti-bot ou timeout : pas une preuve de mort → UNKNOWN,
          // le cron re-vérifiera (lastCheckedAt NULL = prioritaire).
          pending.push(player);
          continue;
        }
        verified.push({ player, mode: 'iframe' });
      }
    }
    if (verified.length === 0 && pending.length === 0) {
      // 422 AVEC le détail par lecteur (la console l'affiche) : sans ça le
      // diagnostic prod (relais vs direct) est perdu.
      return ctx.json({ message: 'Aucun lecteur vérifiable sur cette fiche. Aucun titre créé.', seen, rejected }, 422);
    }
    const title = (typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : preview.title).slice(0, 200);
    const year = body?.year === null || body?.year === undefined ? preview.year : Number(body.year) || null;
    const posterUrl = typeof body?.posterUrl === 'string' && body.posterUrl.trim() ? body.posterUrl.trim() : preview.posterUrl;
    const siteRef = preview.newsid ?? null;
    let titleId;
    const existing = siteRef
      ? await env.db.query(env, `SELECT id FROM "ExternalTitle" WHERE site = $1 AND "siteRef" = $2`, [preview.site, siteRef])
      : { rows: [] };
    if (existing.rows.length > 0) {
      titleId = existing.rows[0].id;
      // Re-publish d'un titre existant : les détails sont rafraîchis aussi
      // (le scraper re-scrappe la fiche) — synopsis/genres récupérés sans
      // devoir supprimer/recréer le titre et ses sources.
      await env.db.query(env,
        `UPDATE "ExternalTitle" SET title = $2, year = $3, "posterUrl" = $4, "backdropUrl" = $5, "trailerYoutubeId" = $6,
           synopsis = $7, "originalTitle" = $8, duration = $9, director = $10, "cast" = $11, genres = $12, "ficheUrl" = $13
         WHERE id = $1`,
        [titleId, title, year, posterUrl, preview.backdropUrl, preview.trailerYoutubeId,
          preview.synopsis ?? null, preview.originalTitle ?? null, preview.duration ?? null, preview.director ?? null, preview.cast ?? null,
          preview.genres ?? [], preview.ficheUrl ?? null],
      );
    } else {
      titleId = crypto.randomUUID();
      await env.db.query(env,
        `INSERT INTO "ExternalTitle" (id, site, "siteRef", title, year, "posterUrl", "backdropUrl", "trailerYoutubeId",
           synopsis, "originalTitle", duration, director, "cast", genres, "ficheUrl")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [titleId, preview.site, siteRef, title, year, posterUrl, preview.backdropUrl, preview.trailerYoutubeId,
          preview.synopsis ?? null, preview.originalTitle ?? null, preview.duration ?? null, preview.director ?? null, preview.cast ?? null,
          preview.genres ?? [], preview.ficheUrl ?? null],
      );
    }
    const known = await env.db.query(env, `SELECT host, "embedUrl" FROM "ExternalSource" WHERE "titleId" = $1`, [titleId]);
    const knownKeys = new Set(known.rows.map((row) => `${row.host}|${row.embedUrl}`));
    let inserted = 0;
    let skipped = 0;
    let order = 0;
    const store = async (player, mode, status) => {
      order += 1;
      if (knownKeys.has(`${player.host}|${player.embedUrl}`)) {
        skipped += 1;
        return;
      }
      await env.db.query(env,
        `INSERT INTO "ExternalSource" (id, "titleId", host, mode, "embedUrl", "finalUrl", versions, "sortOrder", "lastStatus", "lastCheckedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${status === 'OK' ? 'now()' : 'NULL'})`,
        [crypto.randomUUID(), titleId, player.host, mode, player.embedUrl, player.finalUrl, player.versions, order, status],
      );
      inserted += 1;
    };
    for (const { player, mode } of verified) await store(player, mode, 'OK');
    // Surplus non vérifié inline : UNKNOWN + lastCheckedAt NULL → le cron les
    // prend en priorité au prochain passage (NULLS FIRST).
    for (const player of pending) {
      await store(player, SUPPORTED_HOSTS.includes(player.host) ? 'direct' : 'iframe', 'UNKNOWN');
    }
    await audit(ctx, owner.userId, 'vod.external_publish', 'external_title', titleId, { site: preview.site, siteRef, inserted, rejected: rejected.length });
    return ctx.json({ titleId, title, seen, inserted, skipped, pending: pending.length, rejected });
  }

  // Backfill des détails (synopsis/genres/…) des titres déjà publiés :
  // re-scrape la fiche d'origine (ficheUrl stockée) pour remplir les colonnes
  // vides — utiles aux titres importés avant l'ajout des détails.
  if (path === '/api/owner/vod/external/resync' && method === 'POST') {
    const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 4), 20);
    const summary = await resyncExternalMeta(env, limit);
    await audit(ctx, owner.userId, 'vod.external_resync', 'external_title', null, summary);
    return ctx.json(summary);
  }

  // Liste des titres externes + statut de leurs sources.
  if (path === '/api/owner/vod/external/titles' && method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').trim();
    const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 50), 200);
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const params = [];
    const conditions = [];
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`t.title ILIKE $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const [titles, total] = await Promise.all([
      env.db.query(env, `SELECT t.id, t.site, t."siteRef", t.title, t.year, t."posterUrl", t."isVisible", t."sortOrder" FROM "ExternalTitle" t ${where} ORDER BY t."sortOrder" ASC, t."createdAt" DESC LIMIT ${limit} OFFSET ${offset}`, params),
      env.db.query(env, `SELECT COUNT(*)::int AS count FROM "ExternalTitle" t ${where}`, params),
    ]);
    const ids = titles.rows.map((row) => row.id);
    const sources = ids.length > 0
      ? await env.db.query(env, `SELECT id, "titleId", host, mode, "embedUrl", "finalUrl", versions, "sortOrder", "isActive", "lastStatus", "lastError", "lastCheckedAt" FROM "ExternalSource" WHERE "titleId" = ANY($1::text[]) ORDER BY "sortOrder" ASC, "createdAt" ASC`, [ids])
      : { rows: [] };
    const byTitle = new Map();
    for (const source of sources.rows) {
      const list = byTitle.get(source.titleId) ?? [];
      list.push({ ...source, finalUrl: source.finalUrl ?? null, lastError: source.lastError ?? null, lastCheckedAt: source.lastCheckedAt ? new Date(source.lastCheckedAt).toISOString() : null });
      byTitle.set(source.titleId, list);
    }
    return ctx.json({
      items: titles.rows.map((row) => {
        const list = byTitle.get(row.id) ?? [];
        return {
          ...row, siteRef: row.siteRef ?? null, year: row.year ?? null, posterUrl: row.posterUrl ?? null,
          healthySources: list.filter((source) => source.isActive && (source.lastStatus === 'OK' || source.lastStatus === 'UNKNOWN')).length,
          deadSources: list.filter((source) => source.lastStatus === 'DEAD').length,
          sources: list,
        };
      }),
      total: total.rows[0]?.count ?? 0,
    });
  }

  const externalTitleMatch = path.match(/^\/api\/owner\/vod\/external\/titles\/([^/]+)$/);
  if (externalTitleMatch && method === 'PATCH') {
    const id = dec(externalTitleMatch[1]);
    const body = await ctx.readJson().catch(() => ({}));
    const updates = {};
    if (body.title !== undefined && typeof body.title === 'string' && body.title.trim()) updates.title = body.title.trim().slice(0, 200);
    if (body.year !== undefined) updates.year = body.year === null ? null : Number(body.year) || null;
    if (body.posterUrl !== undefined) updates.posterUrl = typeof body.posterUrl === 'string' && body.posterUrl.trim() ? body.posterUrl.trim() : null;
    if (body.isVisible !== undefined) updates.isVisible = Boolean(body.isVisible);
    if (body.sortOrder !== undefined) updates.sortOrder = Math.max(0, Number(body.sortOrder) || 0);
    if (Object.keys(updates).length === 0) return ctx.fail(400, 'Aucune modification');
    const rows = await env.db.query(env, `SELECT id FROM "ExternalTitle" WHERE id = $1`, [id]);
    if (rows.rows.length === 0) return ctx.fail(404, 'Titre introuvable');
    const assignments = Object.keys(updates).map((key, position) => `"${key}" = $${position + 2}`).join(', ');
    await env.db.query(env, `UPDATE "ExternalTitle" SET ${assignments} WHERE id = $1`, [id, ...Object.values(updates)]);
    await audit(ctx, owner.userId, 'vod.external_title_update', 'external_title', id, updates);
    return ctx.json({ ok: true });
  }

  if (externalTitleMatch && method === 'DELETE') {
    const id = dec(externalTitleMatch[1]);
    const done = await env.db.query(env, `DELETE FROM "ExternalTitle" WHERE id = $1 RETURNING id`, [id]);
    if (done.rows.length === 0) return ctx.fail(404, 'Titre introuvable');
    await audit(ctx, owner.userId, 'vod.external_title_delete', 'external_title', id);
    return ctx.json({ ok: true });
  }

  const externalSourceMatch = path.match(/^\/api\/owner\/vod\/external\/sources\/([^/]+)$/);
  if (externalSourceMatch && method === 'PATCH') {
    const id = dec(externalSourceMatch[1]);
    const body = await ctx.readJson().catch(() => ({}));
    const updates = {};
    if (body.isActive !== undefined) updates.isActive = Boolean(body.isActive);
    if (body.sortOrder !== undefined) updates.sortOrder = Math.max(0, Number(body.sortOrder) || 0);
    if (Object.keys(updates).length === 0) return ctx.fail(400, 'Aucune modification');
    const rows = await env.db.query(env, `SELECT id FROM "ExternalSource" WHERE id = $1`, [id]);
    if (rows.rows.length === 0) return ctx.fail(404, 'Source introuvable');
    const assignments = Object.keys(updates).map((key, position) => `"${key}" = $${position + 2}`).join(', ');
    await env.db.query(env, `UPDATE "ExternalSource" SET ${assignments} WHERE id = $1`, [id, ...Object.values(updates)]);
    await audit(ctx, owner.userId, 'vod.external_source_update', 'external_source', id, updates);
    return ctx.json({ ok: true });
  }

  if (externalSourceMatch && method === 'DELETE') {
    const id = dec(externalSourceMatch[1]);
    const done = await env.db.query(env, `DELETE FROM "ExternalSource" WHERE id = $1 RETURNING id`, [id]);
    if (done.rows.length === 0) return ctx.fail(404, 'Source introuvable');
    await audit(ctx, owner.userId, 'vod.external_source_delete', 'external_source', id);
    return ctx.json({ ok: true });
  }

  // Re-vérification immédiate d'une source (probe via l'extracteur).
  const recheckMatch = path.match(/^\/api\/owner\/vod\/external\/sources\/([^/]+)\/recheck$/);
  if (recheckMatch && method === 'POST') {
    const id = dec(recheckMatch[1]);
    const rows = await env.db.query(env, `SELECT id, host, mode, "embedUrl", "finalUrl" FROM "ExternalSource" WHERE id = $1`, [id]);
    if (rows.rows.length === 0) return ctx.fail(404, 'Source introuvable');
    const source = rows.rows[0];
    let check;
    let promoted = false;
    if (source.mode === 'iframe' && SUPPORTED_HOSTS.includes(source.host)) {
      // Verdict identique à la publication : le host a désormais un
      // extracteur et la résolution directe passe → promotion en direct,
      // le film bascule dans le Player Mbolo sans réimport.
      check = await checkSource(env, source.host, source.finalUrl ?? source.embedUrl);
      if (check.ok) {
        await env.db.query(env, `UPDATE "ExternalSource" SET mode = 'direct' WHERE id = $1`, [id]);
        promoted = true;
      } else {
        check = await checkEmbedPage(env, source.embedUrl);
      }
    } else if (source.mode === 'iframe') {
      check = await checkEmbedPage(env, source.embedUrl);
    } else {
      check = await checkSource(env, source.host, source.finalUrl ?? source.embedUrl);
    }
    const status = check.ok ? 'OK' : check.code === 'DEAD' ? 'DEAD' : 'ERROR';
    await env.db.query(env, `UPDATE "ExternalSource" SET "lastStatus" = $2, "lastError" = $3, "lastCheckedAt" = now() WHERE id = $1`,
      [id, status, check.ok ? null : String(check.message ?? '').slice(0, 200)]);
    await audit(ctx, owner.userId, 'vod.external_source_recheck', 'external_source', id, { status, promoted });
    return ctx.json({ id, lastStatus: status, mode: promoted ? 'direct' : source.mode, lastError: check.ok ? null : check.message, detail: check.detail ?? null });
  }

  return ctx.fail(404, 'Route owner VOD inconnue');
}
