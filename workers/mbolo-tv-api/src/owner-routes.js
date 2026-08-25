import { importKey, encryptLocator, decryptLocator, sha256Hex } from './crypto.js';
import { requireOwner, ownerLogin, ownerLogout } from './owner.js';
import { hashPassword } from './password.js';
import { slugify } from './normalize.js';
import { runSourceImport, ACTIVE_IMPORT_STATES } from './importer.js';
import { runEpgImportForSource } from './epgimport.js';
import { checkVariant } from './healthcheck.js';

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

async function audit(ctx, actorId, action, entity, entityId, metadata = {}) {
  await ctx.env.db.query(
    ctx.env,
    `INSERT INTO "AuditLog" (id, "actorId", action, entity, "entityId", metadata, "createdAt") VALUES ($1,$2,$3,$4,$5,$6, now())`,
    [crypto.randomUUID(), actorId, action, entity, entityId ?? null, JSON.stringify(metadata)],
  ).catch(() => undefined);
}

function maskValue(value) {
  if (!value) return '••••';
  const visible = value.replace(/^https?:\/\//, '').slice(0, 4);
  return value.length <= 8 ? '••••' : `${visible}…`;
}

function serializeRun(row) {
  return {
    id: row.id,
    sourceId: row.sourceId,
    sourceName: row.source_name ?? 'source supprimée',
    state: row.state,
    metrics: row.metrics ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
  };
}

function serializeSource(row) {
  return { id: row.id, name: row.name, kind: row.kind, status: row.status, priority: row.priority, lastSyncedAt: iso(row.lastSyncedAt), createdAt: iso(row.createdAt) };
}

export async function handleOwnerRoute(ctx, url, path, method) {
  const { env } = ctx;

  if (path === '/api/owner/auth/login' && method === 'POST') {
    const body = await ctx.readJson().catch(() => null);
    const email = typeof body?.email === 'string' ? body.email : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < 1 || password.length > 200) return ctx.fail(400, 'Validation failed');
    const result = await ownerLogin(ctx, email, password);
    if (result.status === 429) {
      const response = ctx.json({ message: 'Trop de tentatives', statusCode: 429 }, 429);
      response.headers.set('retry-after', String(result.retryAfterSeconds));
      return response;
    }
    if (result.status !== 200) return ctx.fail(result.status, result.message);
    const response = ctx.json(result.value);
    response.headers.append('set-cookie', result.cookie);
    return response;
  }

  if (path === '/api/owner/auth/logout' && method === 'POST') {
    const cookie = await ownerLogout(ctx);
    const response = new Response(null, { status: 204 });
    response.headers.append('set-cookie', cookie);
    return response;
  }

  // Toutes les routes suivantes exigent une session owner valide.
  const owner = await requireOwner(ctx);
  if (!owner) return ctx.fail(401, 'Session invalide');

  if (path === '/api/owner/auth/session' && method === 'GET') {
    const rows = await env.db.query(env, `SELECT s."expiresAt" FROM "OwnerSession" s WHERE s.id = $1`, [owner.sessionId]);
    return ctx.json({ me: { id: owner.userId, email: owner.email, role: 'OWNER' }, sessionId: owner.sessionId, expiresAt: iso(rows.rows[0]?.expiresAt) });
  }

  if (path === '/api/owner/auth/sessions' && method === 'GET') {
    const rows = await env.db.query(env, `SELECT id, "userAgent", "ipHash", "createdAt", "expiresAt" FROM "OwnerSession" WHERE "userId" = $1 AND "revokedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 50`, [owner.userId]);
    return ctx.json(rows.rows.map((row) => ({ id: row.id, userAgent: row.userAgent, ipHash: row.ipHash, createdAt: iso(row.createdAt), expiresAt: iso(row.expiresAt), current: row.id === owner.sessionId })));
  }

  const revokeMatch = path.match(/^\/api\/owner\/auth\/sessions\/([^/]+)$/);
  if (revokeMatch && method === 'DELETE') {
    const rows = await env.db.query(env, `UPDATE "OwnerSession" SET "revokedAt" = now() WHERE id = $1 AND "userId" = $2 RETURNING id`, [decodeURIComponent(revokeMatch[1]), owner.userId]);
    if (rows.rows.length === 0) return ctx.fail(404, 'Session introuvable');
    await audit(ctx, owner.userId, 'owner.session_revoke', 'owner_session', revokeMatch[1]);
    return new Response(null, { status: 204, headers: ctx.corsHeaders() });
  }

  if (path === '/api/owner/profile' && method === 'GET') {
    const rows = await env.db.query(env, `SELECT id, email, role, "whatsappContact" FROM "User" WHERE id = $1`, [owner.userId]);
    return ctx.json(rows.rows[0] ?? {});
  }
  if (path === '/api/owner/profile' && method === 'PATCH') {
    const body = await ctx.readJson().catch(() => ({}));
    if (!('whatsappContact' in body)) return ctx.fail(400, 'Aucune modification');
    const contact = typeof body.whatsappContact === 'string' && body.whatsappContact.trim() !== '' ? body.whatsappContact.trim().slice(0, 120) : null;
    await env.db.query(env, `UPDATE "User" SET "whatsappContact" = $2 WHERE id = $1`, [owner.userId, contact]);
    return ctx.json({ id: owner.userId, email: owner.email, role: 'OWNER', whatsappContact: contact });
  }

  if (path === '/api/owner/overview' && method === 'GET') {
    const [byStatus, channelCount, variantCount, activeImports, liveMatches, recentAudit] = await Promise.all([
      env.db.query(env, `SELECT status, COUNT(*)::int AS count FROM "Source" WHERE "ownerId" = $1 GROUP BY status`, [owner.userId]),
      env.db.query(env, `SELECT COUNT(*)::int AS count FROM "Channel" c WHERE EXISTS (SELECT 1 FROM "StreamVariant" v JOIN "Source" s ON s.id = v."sourceId" WHERE v."channelId" = c.id AND s."ownerId" = $1)`, [owner.userId]),
      env.db.query(env, `SELECT COUNT(*)::int AS count FROM "StreamVariant" v JOIN "Source" s ON s.id = v."sourceId" WHERE s."ownerId" = $1`, [owner.userId]),
      env.db.query(env, `SELECT COUNT(*)::int AS count FROM "ImportRun" r JOIN "Source" s ON s.id = r."sourceId" WHERE s."ownerId" = $1 AND r.state IN ('QUEUED','FETCHING','PARSING','NORMALIZING')`, [owner.userId]),
      env.db.query(env, `SELECT COUNT(*)::int AS count FROM "Match" m WHERE m.state = 'LIVE' AND EXISTS (SELECT 1 FROM "MatchStream" ms JOIN "StreamVariant" v ON v.id = ms."streamVariantId" JOIN "Source" s ON s.id = v."sourceId" WHERE ms."matchId" = m.id AND s."ownerId" = $1)`, [owner.userId]),
      env.db.query(env, `SELECT id, action, entity, "entityId", metadata, "createdAt" FROM "AuditLog" WHERE "actorId" = $1 ORDER BY "createdAt" DESC LIMIT 10`, [owner.userId]),
    ]);
    const sourcesByStatus = Object.fromEntries(byStatus.rows.map((row) => [row.status, row.count]));
    const alerts = [];
    if ((sourcesByStatus.FAILED ?? 0) > 0) alerts.push({ severity: 'critical', message: `${sourcesByStatus.FAILED} source(s) en échec` });
    if ((sourcesByStatus.DEGRADED ?? 0) > 0) alerts.push({ severity: 'warning', message: `${sourcesByStatus.DEGRADED} source(s) dégradée(s)` });
    if ((activeImports.rows[0].count ?? 0) > 0) alerts.push({ severity: 'warning', message: `${activeImports.rows[0].count} import(s) en cours` });
    return ctx.json({
      sourcesByStatus,
      channelCount: channelCount.rows[0].count,
      variantCount: variantCount.rows[0].count,
      activeImports: activeImports.rows[0].count,
      liveMatches: liveMatches.rows[0].count,
      alerts,
      recentAudit: recentAudit.rows.map((row) => ({ id: row.id, action: row.action, entity: row.entity, entityId: row.entityId, actorId: owner.userId, metadata: row.metadata, createdAt: iso(row.createdAt) })),
    });
  }

  if (path === '/api/owner/catalog' && method === 'GET') return ctx.json(await buildOwnerCatalog(ctx, owner));

  if (path === '/api/owner/catalog/channels' && method === 'GET') {
    const q = url.searchParams.get('q');
    const categoryId = url.searchParams.get('categoryId') ?? 'all';
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
    const offset = Number(url.searchParams.get('offset') ?? 0) || 0;
    // Les filtres partagent $1..$n ; LIMIT/OFFSET sont ajoutés ensuite pour le
    // SELECT uniquement (le COUNT ne doit recevoir que les paramètres de filtre).
    const baseParams = [owner.userId];
    let filters = `EXISTS (SELECT 1 FROM "StreamVariant" v JOIN "Source" s ON s.id = v."sourceId" WHERE v."channelId" = c.id AND s."ownerId" = $${baseParams.length})`;
    if (categoryId === 'none') filters += ` AND c."categoryId" IS NULL`;
    else if (categoryId !== 'all') { baseParams.push(categoryId); filters += ` AND c."categoryId" = $${baseParams.length}`; }
    if (q) { baseParams.push(`%${q}%`); filters += ` AND (c.name ILIKE $${baseParams.length} OR c."canonicalName" ILIKE $${baseParams.length})`; }
    const [rows, count] = await Promise.all([
      env.db.query(env, `SELECT c.* FROM "Channel" c WHERE ${filters} ORDER BY c."canonicalName" ASC LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`, [...baseParams, limit, offset]),
      env.db.query(env, `SELECT COUNT(*)::int AS total FROM "Channel" c WHERE ${filters}`, baseParams),
    ]);
    const ids = rows.rows.map((row) => row.id);
    const health = new Map();
    if (ids.length > 0) {
      const variants = await env.db.query(env, `SELECT v."channelId", v."healthStatus" FROM "StreamVariant" v JOIN "Source" s ON s.id = v."sourceId" WHERE v."channelId" = ANY($1::text[]) AND s."ownerId" = $2`, [ids, owner.userId]);
      for (const variant of variants.rows) {
        if (variant.healthStatus === 'OK' || !health.has(variant.channelId)) health.set(variant.channelId, variant.healthStatus);
      }
    }
    return ctx.json({
      items: rows.rows.map((row) => ({ id: row.id, name: row.name, canonicalName: row.canonicalName, categoryId: row.categoryId, isVisible: row.isVisible, healthStatus: health.get(row.id) ?? null, variantsCount: 0 })),
      total: count.rows[0].total,
    });
  }

  const categoryCreate = path === '/api/owner/categories' && method === 'POST';
  if (categoryCreate) return createCategory(ctx, owner);

  const categoryPatch = path.match(/^\/api\/owner\/categories\/([^/]+)$/);
  if (categoryPatch && method === 'PATCH') return patchCategory(ctx, owner, decodeURIComponent(categoryPatch[1]), await ctx.readJson().catch(() => ({})));

  const channelPatch = path.match(/^\/api\/owner\/channels\/([^/]+)$/);
  if (channelPatch && method === 'PATCH') {
    const body = await ctx.readJson().catch(() => ({}));
    const owned = await env.db.query(env, `SELECT c.id FROM "Channel" c WHERE c.id = $1 AND EXISTS (SELECT 1 FROM "StreamVariant" v JOIN "Source" s ON s.id = v."sourceId" WHERE v."channelId" = c.id AND s."ownerId" = $2)`, [decodeURIComponent(channelPatch[1]), owner.userId]);
    if (owned.rows.length === 0) return ctx.fail(404, 'Channel not found');
    if (body.name !== undefined || body.isVisible !== undefined) {
      await env.db.query(env, `UPDATE "Channel" SET name = COALESCE($2, name), "canonicalName" = COALESCE($2, "canonicalName"), "isVisible" = COALESCE($3, "isVisible") WHERE id = $1`, [owned.rows[0].id, typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 160) : null, typeof body.isVisible === 'boolean' ? body.isVisible : null]);
      await audit(ctx, owner.userId, 'catalog.channel_update', 'channel', owned.rows[0].id, { name: body.name, isVisible: body.isVisible });
    }
    return ctx.json(await buildOwnerCatalog(ctx, owner));
  }

  const channelTest = path.match(/^\/api\/owner\/channels\/([^/]+)\/test$/);
  if (channelTest && method === 'POST') {
    const key = await importKey(env.ENCRYPTION_KEY);
    const variants = await env.db.query(env, `SELECT v.id, v."encryptedLocator" FROM "StreamVariant" v JOIN "Source" s ON s.id = v."sourceId" WHERE v."channelId" = $1 AND v."isActive" AND s."ownerId" = $2 ORDER BY v."healthScore" DESC`, [decodeURIComponent(channelTest[1]), owner.userId]);
    let checked = 0;
    let status = 'DOWN';
    for (const variant of variants.rows) {
      checked += 1;
      if ((await checkVariant(env, key, variant)) === 'OK') { status = 'OK'; break; }
    }
    await audit(ctx, owner.userId, 'catalog.channel_test', 'channel', decodeURIComponent(channelTest[1]), { checked, ok: status === 'OK' });
    return ctx.json({ ok: status === 'OK', status, checked });
  }

  const catDelete = path.match(/^\/api\/owner\/categories\/([^/]+)$/);
  if (catDelete && method === 'DELETE') {
    const id = decodeURIComponent(catDelete[1]);
    const rows = await ctx.env.db.query(ctx.env, `SELECT id, "parentId", name FROM "Category" WHERE id = $1`, [id]);
    const category = rows.rows[0];
    if (!category) return ctx.fail(404, 'Category not found');
    // Aucune perte : les chaînes du dossier passent en « sans dossier » et les
    // sous-dossiers remontent au parent supprimé.
    await ctx.env.db.query(ctx.env, `UPDATE "Channel" SET "categoryId" = NULL WHERE "categoryId" = $1`, [id]);
    await ctx.env.db.query(ctx.env, `UPDATE "Category" SET "parentId" = $2 WHERE "parentId" = $1`, [id, category.parentId]);
    await ctx.env.db.query(ctx.env, `DELETE FROM "Category" WHERE id = $1`, [id]);
    await audit(ctx, owner.userId, 'catalog.category_delete', 'category', id, { name: category.name });
    return ctx.json(await buildOwnerCatalog(ctx, owner));
  }

  if (path === '/api/owner/sources' && method === 'GET') {
    const rows = await env.db.query(env, `SELECT * FROM "Source" WHERE "ownerId" = $1 ORDER BY priority ASC, "createdAt" ASC`, [owner.userId]);
    return ctx.json(rows.rows.map(serializeSource));
  }

  if (path === '/api/owner/sources' && method === 'POST') {
    const body = await ctx.readJson().catch(() => null);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const kind = ['M3U', 'XTREAM', 'MAC_PORTAL'].includes(body?.kind) ? body.kind : null;
    if (name.length < 2 || name.length > 80 || !kind || typeof body.connection !== 'object' || body.connection === null) return ctx.fail(400, 'Validation failed');
    const key = await importKey(env.ENCRYPTION_KEY);
    const sourceId = crypto.randomUUID();
    await env.db.query(
      env,
      `INSERT INTO "Source" (id, "ownerId", name, kind, status, priority, "connectionEncrypted") VALUES ($1,$2,$3,$4,'PENDING',100,$5)`,
      [sourceId, owner.userId, name, kind, await encryptLocator(key, JSON.stringify(body.connection))],
    );
    await audit(ctx, owner.userId, 'source.create', 'source', sourceId, { kind, name });
    if (kind === 'M3U' && (body.connection.url || body.connection.playlistUrl)) {
      const runId = await startImportRun(ctx, sourceId);
      ctx.waitUntil(runImportAndEpg(ctx, sourceId, runId));
    }
    const created = await env.db.query(env, `SELECT * FROM "Source" WHERE id = $1`, [sourceId]);
    return ctx.json(serializeSource(created.rows[0]));
  }

  const sourceDetail = path.match(/^\/api\/owner\/sources\/([^/]+)(\/(test|credentials|import|playlist))?$/);
  if (sourceDetail && sourceDetail[3] === 'test' && method === 'GET') {
    const source = await findOwnedSource(ctx, owner, sourceDetail[1]);
    if (!source) return ctx.fail(404, 'Source introuvable');
    const started = Date.now();
    try {
      const key = await importKey(env.ENCRYPTION_KEY);
      const connection = JSON.parse(await decryptLocator(key, source.connectionEncrypted));
      const probe = source.kind === 'M3U'
        ? connection.url ?? connection.playlistUrl
        : source.kind === 'XTREAM'
          ? `${connection.url.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(connection.username)}&password=${encodeURIComponent(connection.password)}&action=get_live_categories`
          : null;
      if (!probe) return ctx.json({ ok: false, latencyMs: null, error: 'Connexion incomplète : paramètres manquants' });
      const response = await fetch(probe, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'Mozilla/5.0' } });
      return ctx.json({ ok: response.ok, latencyMs: Date.now() - started, error: response.ok ? null : `HTTP ${response.status}` });
    } catch (error) {
      return ctx.json({ ok: false, latencyMs: Date.now() - started, error: String(error.message).replace(/https?:\/\/[^\s]+/g, '[url masquée]') });
    }
  }
  if (sourceDetail && sourceDetail[3] === 'credentials' && method === 'GET') {
    const source = await findOwnedSource(ctx, owner, sourceDetail[1]);
    if (!source) return ctx.fail(404, 'Source introuvable');
    const key = await importKey(env.ENCRYPTION_KEY);
    try {
      return ctx.json({ connection: JSON.parse(await decryptLocator(key, source.connectionEncrypted)) });
    } catch {
      return ctx.json({ connection: {} });
    }
  }
  if (sourceDetail && sourceDetail[3] === 'import' && method === 'POST') {
    const source = await findOwnedSource(ctx, owner, sourceDetail[1]);
    if (!source) return ctx.fail(404, 'Source introuvable');
    if (source.status === 'DISABLED') return ctx.fail(409, 'Source désactivée');
    const runId = await startImportRun(ctx, source.id);
    await audit(ctx, owner.userId, 'source.import_request', 'source', source.id, { importRunId: runId });
    ctx.waitUntil(runImportAndEpg(ctx, source.id, runId));
    const run = await env.db.query(env, `SELECT r.*, s.name AS source_name FROM "ImportRun" r JOIN "Source" s ON s.id = r."sourceId" WHERE r.id = $1`, [runId]);
    return ctx.json(serializeRun(run.rows[0]));
  }
  if (sourceDetail && !sourceDetail[2] && method === 'GET') {
    const source = await findOwnedSource(ctx, owner, sourceDetail[1]);
    if (!source) return ctx.fail(404, 'Source introuvable');
    const key = await importKey(env.ENCRYPTION_KEY);
    const counts = await env.db.query(env, `SELECT COUNT(*)::int AS count FROM "StreamVariant" WHERE "sourceId" = $1`, [source.id]);
    let connectionMasked = {};
    try {
      const connection = JSON.parse(await decryptLocator(key, source.connectionEncrypted));
      connectionMasked = Object.fromEntries(Object.entries(connection).map(([entryKey, value]) => [entryKey, maskValue(String(value))]));
    } catch {
      connectionMasked = { error: 'Impossible de déchiffrer la connexion' };
    }
    return ctx.json({ ...serializeSource(source), connectionMasked, variantsCount: counts.rows[0].count });
  }
  if (sourceDetail && !sourceDetail[2] && method === 'PATCH') {
    const source = await findOwnedSource(ctx, owner, sourceDetail[1]);
    if (!source) return ctx.fail(404, 'Source introuvable');
    const body = await ctx.readJson().catch(() => ({}));
    const name = typeof body.name === 'string' && body.name.trim().length >= 2 && body.name.trim().length <= 80 ? body.name.trim() : source.name;
    const priority = Number.isInteger(body.priority) && body.priority >= 1 && body.priority <= 1000 ? body.priority : source.priority;
    const status = ['READY', 'DEGRADED', 'FAILED', 'DISABLED'].includes(body.status) ? body.status : source.status;
    await env.db.query(env, `UPDATE "Source" SET name = $2, priority = $3, status = $4 WHERE id = $1`, [source.id, name, priority, status]);
    const updated = await env.db.query(env, `SELECT * FROM "Source" WHERE id = $1`, [source.id]);
    return ctx.json(serializeSource(updated.rows[0]));
  }
  if (sourceDetail && !sourceDetail[2] && method === 'DELETE') {
    const source = await findOwnedSource(ctx, owner, sourceDetail[1]);
    if (!source) return ctx.fail(404, 'Source introuvable');
    // Suppression en 2 temps comme sources.service.remove() : la source
    // d'abord (cascade StreamVariant/EpgProgramme), puis purge des canaux
    // orphelins (plus aucune variante) pour mettre à jour le catalogue public.
    const activeRun = await ctx.env.db.query(ctx.env, `SELECT id FROM "ImportRun" WHERE "sourceId" = $1 AND state IN ('QUEUED','FETCHING','PARSING','NORMALIZING') LIMIT 1`, [source.id]);
    if (activeRun.rows.length > 0) return ctx.fail(409, 'Impossible de supprimer une source pendant un import. Annulez l’import puis réessayez.');
    await ctx.env.db.query(ctx.env, `DELETE FROM "Source" WHERE id = $1`, [source.id]);
    const orphanChannels = await ctx.env.db.query(
      ctx.env,
      `SELECT c.id FROM "Channel" c
       WHERE NOT EXISTS (SELECT 1 FROM "StreamVariant" v WHERE v."channelId" = c.id)
         AND NOT EXISTS (SELECT 1 FROM "EpgProgramme" p WHERE p."channelId" = c.id)`,
      [],
    );
    let orphanChannelsRemoved = 0;
    for (const part of chunks(orphanChannels.rows.map((row) => row.id), 10000)) {
      await ctx.env.db.query(ctx.env, `DELETE FROM "Favorite" WHERE "channelId" = ANY($1::text[])`, [part]).catch(() => undefined);
      const result = await ctx.env.db.query(ctx.env, `DELETE FROM "Channel" WHERE id = ANY($1::text[]) RETURNING id`, [part]);
      orphanChannelsRemoved += result.rowCount;
    }
    void orphanChannelsRemoved;
    await audit(ctx, owner.userId, 'source.delete', 'source', source.id, { name: source.name });
    return new Response(null, { status: 204, headers: ctx.corsHeaders() });
  }

  if (path === '/api/owner/imports' && method === 'GET') {
    const rows = await env.db.query(env, `SELECT r.*, s.name AS source_name FROM "ImportRun" r JOIN "Source" s ON s.id = r."sourceId" WHERE s."ownerId" = $1 ORDER BY r."startedAt" DESC LIMIT 100`, [owner.userId]);
    return ctx.json({ items: rows.rows.map(serializeRun), total: rows.rows.length });
  }

  const importCancel = path.match(/^\/api\/owner\/imports\/([^/]+)\/cancel$/);
  if (importCancel && method === 'POST') {
    const rows = await env.db.query(env, `SELECT r.*, s.name AS source_name FROM "ImportRun" r JOIN "Source" s ON s.id = r."sourceId" WHERE r.id = $1 AND s."ownerId" = $2`, [decodeURIComponent(importCancel[1]), owner.userId]);
    const current = rows.rows[0];
    if (!current) return ctx.fail(404, 'Import introuvable');
    if (!ACTIVE_IMPORT_STATES.includes(current.state)) return ctx.json(serializeRun(current));
    await env.db.query(env, `UPDATE "ImportRun" SET state = 'CANCELED', "errorCode" = 'CANCELED', "errorMessage" = 'Import annulé par l’utilisateur', "completedAt" = now() WHERE id = $1 AND state IN ('QUEUED','FETCHING','PARSING','NORMALIZING')`, [current.id]);
    await env.db.query(env, `UPDATE "Source" SET status = 'READY' WHERE id = $1 AND status = 'IMPORTING'`, [current.sourceId]);
    await audit(ctx, owner.userId, 'import.canceled', 'source', current.sourceId, { importRunId: current.id });
    const updated = await env.db.query(env, `SELECT r.*, s.name AS source_name FROM "ImportRun" r JOIN "Source" s ON s.id = r."sourceId" WHERE r.id = $1`, [current.id]);
    return ctx.json(serializeRun(updated.rows[0]));
  }

  const importDetail = path.match(/^\/api\/owner\/imports\/([^/]+)$/);
  if (importDetail && method === 'GET') {
    const rows = await env.db.query(env, `SELECT r.*, s.name AS source_name FROM "ImportRun" r JOIN "Source" s ON s.id = r."sourceId" WHERE r.id = $1 AND s."ownerId" = $2`, [decodeURIComponent(importDetail[1]), owner.userId]);
    if (rows.rows.length === 0) return ctx.fail(404, 'Import introuvable');
    return ctx.json(serializeRun(rows.rows[0]));
  }

  if (path === "/api/owner/catalog/purge-empty" && method === "POST") {
    const cats = await ctx.env.db.query(ctx.env, `SELECT id, "parentId" FROM "Category"`);
    const counts = await ctx.env.db.query(ctx.env, `SELECT "categoryId", COUNT(*)::int AS count FROM "Channel" GROUP BY "categoryId"`);
    const countByCat = new Map(counts.rows.map((row) => [row.categoryId, row.count]));
    const childrenByParent = new Map();
    for (const row of cats.rows) {
      const bucket = childrenByParent.get(row.parentId) ?? [];
      bucket.push(row);
      childrenByParent.set(row.parentId, bucket);
    }
    const memo = new Map();
    const visiting = new Set();
    const subtreeCount = (id) => {
      const cached = memo.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      let total = countByCat.get(id) ?? 0;
      for (const child of childrenByParent.get(id) ?? []) total += subtreeCount(child.id);
      visiting.delete(id);
      memo.set(id, total);
      return total;
    };
    // Un dossier est inutile si son sous-arbre entier ne contient AUCUNE chaîne :
    // ses enfants vides sont dans la même liste, la suppression groupée est sûre.
    const toDelete = cats.rows.filter((row) => subtreeCount(row.id) === 0).map((row) => row.id);
    let deleted = 0;
    for (const part of chunks(toDelete, 500)) {
      const result = await ctx.env.db.query(ctx.env, `DELETE FROM "Category" WHERE id = ANY($1::text[]) RETURNING id`, [part]);
      deleted += result.rowCount;
    }
    await audit(ctx, owner.userId, "catalog.purge_empty", "category", null, { deleted, examined: cats.rows.length });
    return ctx.json({ deleted, examined: cats.rows.length, kept: cats.rows.length - deleted });
  }

  if (path === "/api/owner/audit" && method === "GET") {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
    const offset = Number(url.searchParams.get('offset') ?? 0) || 0;
    const [rows, count] = await Promise.all([
      env.db.query(env, `SELECT * FROM "AuditLog" WHERE "actorId" = $1 ORDER BY "createdAt" DESC LIMIT $2 OFFSET $3`, [owner.userId, limit, offset]),
      env.db.query(env, `SELECT COUNT(*)::int AS total FROM "AuditLog" WHERE "actorId" = $1`, [owner.userId]),
    ]);
    return ctx.json({
      items: rows.rows.map((row) => ({ id: row.id, action: row.action, entity: row.entity, entityId: row.entityId, actorId: row.actorId, metadata: row.metadata, createdAt: iso(row.createdAt) })),
      total: count.rows[0].total,
    });
  }

  if (path === '/api/owner/access-codes' && method === 'GET') {
    const rows = await env.db.query(
      env,
      `SELECT a.*, g."expiresAt" AS grant_expires FROM "AccessCode" a LEFT JOIN "DeviceGrant" g ON g."accessCodeId" = a.id
       WHERE a."createdById" = $1 ORDER BY a."createdAt" DESC LIMIT 200`,
      [owner.userId],
    );
    return ctx.json(rows.rows.map((row) => ({ id: row.id, code: null, codeLast4: row.codeLast4, kind: row.kind, durationHours: row.durationHours, active: row.active && !row.revokedAt, createdAt: iso(row.createdAt), expiresAt: iso(row.grant_expires), deviceBound: Boolean(row.grant_expires) })));
  }
  if (path === '/api/owner/access-codes' && method === 'POST') {
    const body = await ctx.readJson().catch(() => ({}));
    const kind = body.kind === 'PROMO' ? 'PROMO' : 'STANDARD';
    const durationHours = kind === 'PROMO' ? 24 : ([7, 14, 30].includes(body.durationDays) ? body.durationDays : 7) * 24;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rawCode = `${kind === 'PROMO' ? 'PROMO' : 'MBLO'}-${hexRandom(5)}`;
      const codeHash = await sha256Hex(rawCode);
      try {
        const inserted = await env.db.query(env, `INSERT INTO "AccessCode" (id, "codeHash", "codeLast4", kind, "durationHours", active, "createdById") VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING id`, [crypto.randomUUID(), codeHash, rawCode.slice(-4), kind, durationHours, owner.userId]);
        await audit(ctx, owner.userId, 'access_code.create', 'access_code', inserted.rows[0].id, { kind, durationHours });
        return ctx.json({ id: inserted.rows[0].id, code: rawCode, codeLast4: rawCode.slice(-4), kind, durationHours, active: true, createdAt: new Date().toISOString(), expiresAt: null, deviceBound: false });
      } catch {
        if (attempt === 4) return ctx.fail(500, 'Impossible de générer un code');
      }
    }
    return ctx.fail(500, 'Impossible de générer un code');
  }
  const accessRevoke = path.match(/^\/api\/owner\/access-codes\/([^/]+)$/);
  if (accessRevoke && method === 'DELETE') {
    const rows = await env.db.query(env, `UPDATE "AccessCode" SET active = false, "revokedAt" = now() WHERE id = $1 AND "createdById" = $2 RETURNING id`, [decodeURIComponent(accessRevoke[1]), owner.userId]);
    if (rows.rows.length === 0) return ctx.fail(404, 'Code introuvable');
    await audit(ctx, owner.userId, 'access_code.revoke', 'access_code', accessRevoke[1], {});
    return new Response(null, { status: 204, headers: ctx.corsHeaders() });
  }

  return null;
}

function hexRandom(bytes) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return [...values].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function findOwnedSource(ctx, owner, id) {
  const rows = await ctx.env.db.query(ctx.env, `SELECT * FROM "Source" WHERE id = $1 AND "ownerId" = $2`, [id, owner.userId]);
  return rows.rows[0] ?? null;
}

export async function startImportRun(ctx, sourceId) {
  const active = await ctx.env.db.query(ctx.env, `SELECT id FROM "ImportRun" WHERE "sourceId" = $1 AND state IN ('QUEUED','FETCHING','PARSING','NORMALIZING') LIMIT 1`, [sourceId]);
  if (active.rows.length > 0) throw Object.assign(new Error('Un import est déjà en cours pour cette source'), { status: 409 });
  const runId = crypto.randomUUID();
  await ctx.env.db.query(ctx.env, `INSERT INTO "ImportRun" (id, "sourceId", state, "startedAt") VALUES ($1,$2,'QUEUED', now())`, [runId, sourceId]);
  return runId;
}

// Exécution asynchrone sans file d'attente : waitUntil prolonge la requête
// et le Cron Trigger reprend tout ImportRun QUEUED resté en attente.
export async function runImportAndEpg(ctx, sourceId, runId) {
  const result = await runSourceImport(ctx.env, sourceId, runId);
  if (result?.ok) await runEpgImportForSource(ctx.env, sourceId).catch(() => undefined);
}

export async function resumeQueuedImports(env) {
  const queued = await env.db.query(env, `SELECT id, "sourceId" FROM "ImportRun" WHERE state = 'QUEUED' ORDER BY "startedAt" ASC LIMIT 3`);
  for (const row of queued.rows) await runSourceImport(env, row.sourceId, row.id);
  return queued.rows.length;
}

async function createCategory(ctx, owner) {
  const body = await ctx.readJson().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 120) return ctx.fail(400, 'Validation failed');
  const parentId = body.parentId ?? null;
  if (parentId) {
    const parent = await ctx.env.db.query(ctx.env, `SELECT id FROM "Category" WHERE id = $1`, [parentId]);
    if (parent.rows.length === 0) return ctx.fail(400, 'Parent invalide');
  }
  let slug = slugify(name);
  if (!slug) slug = `categorie-${Date.now()}`;
  let candidate = slug;
  for (let suffix = 2; ; suffix += 1) {
    const exists = await ctx.env.db.query(ctx.env, `SELECT 1 FROM "Category" WHERE slug = $1 LIMIT 1`, [candidate]);
    if (exists.rows.length === 0) break;
    candidate = `${slug}-${suffix}`;
  }
  const maxRow = await ctx.env.db.query(ctx.env, `SELECT COALESCE(MAX("sortOrder"), -1)::int AS max FROM "Category"`);
  const created = await ctx.env.db.query(ctx.env, `INSERT INTO "Category" (id, slug, name, "sortOrder", "isVisible", "parentId") VALUES ($1,$2,$3,$4,true,$5) RETURNING id`, [crypto.randomUUID(), candidate, name, maxRow.rows[0].max + 1, parentId]);
  await audit(ctx, owner.userId, 'catalog.category_create', 'category', created.rows[0].id, { name });
  return ctx.json(await buildOwnerCatalog(ctx, owner));
}

async function patchCategory(ctx, owner, id, body) {
  const { env } = ctx;
  const rows = await env.db.query(env, `SELECT * FROM "Category" WHERE id = $1`, [id]);
  const category = rows.rows[0];
  if (!category) return ctx.fail(404, 'Category not found');
  const updates = {};
  if (body.name !== undefined) updates.name = String(body.name).trim().slice(0, 120);
  if (body.isVisible !== undefined) updates.isVisible = Boolean(body.isVisible);
  if (body.sortOrder !== undefined) updates.sortOrder = Number(body.sortOrder) || 0;
  if (body.parentId !== undefined) {
    if (body.parentId === id) return ctx.fail(400, 'Un parent ne peut pas être lui-même');
    if (body.parentId) {
      let cursor = body.parentId;
      while (cursor) {
        if (cursor === id) return ctx.fail(400, 'Cycle détecté dans l’arbre');
        const parentRow = await env.db.query(env, `SELECT "parentId" FROM "Category" WHERE id = $1`, [cursor]);
        cursor = parentRow.rows[0]?.parentId ?? null;
      }
    }
    updates.parentId = body.parentId || null;
  }
  const keys = Object.keys(updates);
  if (keys.length === 0) return ctx.fail(400, 'Aucune modification');
  const assignments = keys.map((key, index) => `"${key}" = $${index + 2}`).join(', ');
  await env.db.query(env, `UPDATE "Category" SET ${assignments} WHERE id = $1`, [id, ...Object.values(updates)]);
  await audit(ctx, owner.userId, 'catalog.category_update', 'category', id, updates);
  return ctx.json(await buildOwnerCatalog(ctx, owner));
}

async function buildOwnerCatalog(ctx, owner) {
  const { env } = ctx;
  const categories = await env.db.query(env, `SELECT id, slug, name, "parentId", "sortOrder", "isVisible" FROM "Category" ORDER BY "sortOrder" ASC, name ASC`);
  const byId = new Map(categories.rows.map((row) => [row.id, row]));
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
  categories.rows.forEach((row) => computeEffective(row.id));

  const childrenByParent = new Map();
  for (const row of categories.rows) {
    const bucket = childrenByParent.get(row.parentId) ?? [];
    bucket.push(row);
    childrenByParent.set(row.parentId, bucket);
  }
  const buildVisiting = new Set();
  const buildNode = (row) => {
    if (buildVisiting.has(row.id)) return { id: row.id, slug: row.slug, name: row.name, parentId: row.parentId, isVisible: row.isVisible, effectiveVisible: effective.get(row.id) ?? false, channelCount: 0, sortOrder: row.sortOrder, channels: [], children: [] };
    buildVisiting.add(row.id);
    const children = (childrenByParent.get(row.id) ?? []).map(buildNode);
    buildVisiting.delete(row.id);
    return { id: row.id, slug: row.slug, name: row.name, parentId: row.parentId, isVisible: row.isVisible, effectiveVisible: effective.get(row.id) ?? false, channelCount: 0, sortOrder: row.sortOrder, channels: [], children };
  };

  const roots = categories.rows
    .filter((row) => row.parentId == null)
    .map(buildNode);

  const uncategorizedRows = await env.db.query(
    env,
    `SELECT c.id, c.name, c."canonicalName", c."categoryId", c."isVisible",
            CASE WHEN COUNT(v.id) FILTER (WHERE v."healthStatus" = 'OK') > 0 THEN 'OK'
                 WHEN COUNT(v.id) FILTER (WHERE v."healthStatus" = 'DOWN') > 0 THEN 'DOWN'
                 ELSE NULL END AS "healthStatus",
            COUNT(v.id)::int AS "variantsCount"
     FROM "Channel" c
     LEFT JOIN "StreamVariant" v ON v."channelId" = c.id
     WHERE c."categoryId" IS NULL AND EXISTS (SELECT 1 FROM "StreamVariant" v2 JOIN "Source" s ON s.id = v2."sourceId" WHERE v2."channelId" = c.id AND s."ownerId" = $1)
     GROUP BY c.id ORDER BY c."canonicalName" ASC`,
    [owner.userId],
  );

  const counts = await env.db.query(env, `SELECT "categoryId", COUNT(*)::int AS count FROM "Channel" GROUP BY "categoryId"`);
  const countByCategory = new Map(counts.rows.map((row) => [row.categoryId, row.count]));
  const assignCounts = (node) => {
    node.channelCount = countByCategory.get(node.id) ?? 0;
    node.children.forEach(assignCounts);
    return node;
  };
  roots.forEach(assignCounts);
  return { categories: roots, uncategorized: uncategorizedRows.rows, uncategorizedCount: uncategorizedRows.rows.length };
}
