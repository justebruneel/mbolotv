import { importKey, encryptLocator, decryptLocator } from './crypto.js';
import { slugify, detectCountry } from './normalize.js';
import { parseM3uStream } from './m3u.js';
import { fetchXtreamEntries } from './xtream.js';

const BATCH = 5000;
const QUERY_BATCH = 2000;
export const ACTIVE_IMPORT_STATES = ['QUEUED', 'FETCHING', 'PARSING', 'NORMALIZING'];

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function catalogKey(title, country, group) {
  const scope = [country, group].filter(Boolean).map((value) => slugify(value)).filter(Boolean).join('--');
  const titleKey = slugify(title);
  return scope ? `${titleKey}--${scope}` : titleKey;
}

class ImportError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function fetchWithLimits(url, { maxBytes = 512 * 1024 * 1024, timeoutMs = 300_000 } = {}) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok && response.status >= 400) throw new Error(`Échec de téléchargement (HTTP ${response.status})`);
  return response;
}

// Pipeline d'import fidèle à ImportProcessor. Les logos ne sont PAS
// re-téléchargés : l'URL d'origine est conservée comme logoKey (comportement
// de repli du code Nest), ce qui évite tout stockage côté Worker.
export async function runSourceImport(env, sourceId, importRunId) {
  const key = await importKey(env.ENCRYPTION_KEY);
  const fail = async (code, error) => {
    const message = String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s]+/g, '[url masquée]').slice(0, 300);
    await env.db.query(env, `UPDATE "ImportRun" SET state = 'FAILED', "errorCode" = $2, "errorMessage" = $3, "completedAt" = now() WHERE id = $1`, [importRunId, code, message]).catch(() => undefined);
    await env.db.query(env, `UPDATE "Source" SET status = 'FAILED' WHERE id = $1`, [sourceId]).catch(() => undefined);
  };

  try {
    const runRows = await env.db.query(env, `SELECT state FROM "ImportRun" WHERE id = $1`, [importRunId]);
    const sourceRows = await env.db.query(env, `SELECT id, kind, status, "connectionEncrypted" FROM "Source" WHERE id = $1`, [sourceId]);
    const run = runRows.rows[0];
    const source = sourceRows.rows[0];
    if (!run || !source || run.state === 'CANCELED') return null;
    if (source.status === 'DISABLED') { await fail('SOURCE_DISABLED', new Error('Source désactivée')); return null; }

    await env.db.query(env, `UPDATE "ImportRun" SET state = 'FETCHING', "startedAt" = now() WHERE id = $1`, [importRunId]);
    await env.db.query(env, `UPDATE "Source" SET status = 'IMPORTING' WHERE id = $1`, [sourceId]);

    let connection;
    try {
      connection = JSON.parse(await decryptLocator(key, source.connectionEncrypted));
    } catch {
      throw new ImportError('DECRYPT_ERROR', 'Connexion source illisible (clé de chiffrement différente)');
    }

    const metrics = { read: 0, processed: 0, created: 0, updated: 0, duplicates: 0, ignored: 0, errors: 0, pruned: 0, logos: 0 };
    const seenInput = new Set();
    const seenChannelIds = new Set();
    const persistMetrics = (extra = {}) =>
      env.db
        .query(env, `UPDATE "ImportRun" SET metrics = $2 WHERE id = $1`, [importRunId, JSON.stringify({ ...metrics, ...extra })])
        .catch(() => undefined);

    if (source.kind === 'M3U') {
      const url = connection.url ?? connection.playlistUrl;
      if (!url) throw new ImportError('MISSING_URL', 'URL de playlist ou fichier local manquant');
      await env.db.query(env, `UPDATE "ImportRun" SET state = 'PARSING' WHERE id = $1`, [importRunId]);
      const maxBytes = Number(env.IMPORT_MAX_BYTES ?? 512 * 1024 * 1024);
      const response = await fetchWithLimits(url, { maxBytes, timeoutMs: Number(env.IMPORT_FETCH_TIMEOUT_MS ?? 300_000) });
      const entries = [];
      await parseM3uStream(response.body, (entry) => entries.push(entry), maxBytes);
      metrics.read = entries.length;
      await persistMetrics();
      await ingestEntries(env, key, source, entries, importRunId, metrics, seenInput, seenChannelIds, persistMetrics);
    } else if (source.kind === 'XTREAM') {
      if (!connection.url || !connection.username || !connection.password) throw new ImportError('MISSING_CREDENTIALS', 'Identifiants Xtream manquants');
      await env.db.query(env, `UPDATE "ImportRun" SET state = 'PARSING' WHERE id = $1`, [importRunId]);
      let entries;
      try {
        ({ entries } = await fetchXtreamEntries(connection));
      } catch (error) {
        throw new ImportError('CONNECTOR_ERROR', error.message);
      }
      metrics.read = entries.length;
      await persistMetrics();
      await ingestEntries(env, key, source, entries, importRunId, metrics, seenInput, seenChannelIds, persistMetrics);
    } else {
      throw new ImportError('UNSUPPORTED_KIND', 'Type de source non pris en charge dans le Worker');
    }

    // Prune : variantes actives de la source absentes du dernier flux.
    const active = await env.db.query(env, `SELECT id, "channelId" FROM "StreamVariant" WHERE "sourceId" = $1 AND "isActive"`, [sourceId]);
    const toPrune = active.rows.filter((variant) => !seenChannelIds.has(variant.channelId));
    for (const part of chunks(toPrune, 500)) {
      const result = await env.db.query(env, `UPDATE "StreamVariant" SET "isActive" = false WHERE id = ANY($1::text[])`, [part.map((variant) => variant.id)]);
      metrics.pruned += result.rowCount;
    }
    metrics.ignored = Math.max(0, metrics.read - metrics.created - metrics.updated - metrics.duplicates - metrics.errors);

    const completed = await env.db.query(env, `UPDATE "ImportRun" SET state = 'COMPLETED', metrics = $2, "completedAt" = now() WHERE id = $1 AND state <> 'CANCELED' RETURNING id`, [importRunId, JSON.stringify(metrics)]);
    if (completed.rows.length > 0) {
      await env.db.query(env, `UPDATE "Source" SET status = 'READY', "lastSyncedAt" = now() WHERE id = $1`, [sourceId]);
      await env.db.query(
        env,
        `INSERT INTO "AuditLog" (id, "actorId", action, entity, "entityId", metadata, "createdAt")
         VALUES ($1, $2, 'import.completed', 'source', $3, $4, now())`,
        [crypto.randomUUID(), source.ownerId ?? null, sourceId, JSON.stringify({ importRunId, metrics })],
      ).catch(() => undefined);
    }
    return { ok: true, metrics };
  } catch (error) {
    if (!(error instanceof ImportError)) await fail('INTERNAL', error);
    else await fail(error.code, error);
    return { ok: false };
  }
}

async function ingestEntries(env, cryptoKey, source, entries, importRunId, metrics, seenInput, seenChannelIds, persistMetrics = null) {
  const flush = persistMetrics ?? ((extra = {}) => env.db.query(env, `UPDATE "ImportRun" SET metrics = $2 WHERE id = $1`, [importRunId, JSON.stringify({ ...metrics, ...extra })]).catch(() => undefined));
  await env.db.query(env, `UPDATE "ImportRun" SET state = 'NORMALIZING' WHERE id = $1`, [importRunId]);
  await flush();
  const categorySlugs = new Set();
  const categoryNameBySlug = new Map();
  const metas = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    try {
      const country = detectCountry(entry.title, entry.groupTitle);
      const normalizedKey = catalogKey(entry.title, country, entry.groupTitle);
      if (seenInput.has(normalizedKey)) { metrics.duplicates += 1; continue; }
      seenInput.add(normalizedKey);
      const categorySlug = entry.groupTitle ? slugify(entry.groupTitle) : null;
      if (categorySlug) {
        categorySlugs.add(categorySlug);
        if (!categoryNameBySlug.has(categorySlug)) categoryNameBySlug.set(categorySlug, entry.groupTitle);
      }
      metas.push({ ...entry, key: normalizedKey, legacyKey: slugify(entry.title), country, categorySlug, sortOrder: index + 1 });
    } catch {
      metrics.errors += 1;
    }
  }

  const lookupKeys = [...new Set(metas.flatMap((entry) => [entry.key, entry.legacyKey]))];
  const channelByKey = new Map();
  for (const part of chunks(lookupKeys, QUERY_BATCH)) {
    const rows = await env.db.query(env, `SELECT id, name, "canonicalName", "normalizedKey", "tvgId", country, "categoryId", "sortOrder", "logoKey" FROM "Channel" WHERE "normalizedKey" = ANY($1::text[])`, [part]);
    for (const row of rows.rows) channelByKey.set(row.normalizedKey, row);
  }
  const categoryBySlug = new Map();
  for (const part of chunks([...categorySlugs], QUERY_BATCH)) {
    const rows = await env.db.query(env, `SELECT id, slug, name, "sortOrder" FROM "Category" WHERE slug = ANY($1::text[])`, [part]);
    for (const row of rows.rows) categoryBySlug.set(row.slug, row);
  }

  const existingIds = [...channelByKey.values()].map((channel) => channel.id);
  const variantByChannelId = new Map();
  for (const part of chunks(existingIds, QUERY_BATCH)) {
    const rows = await env.db.query(env, `SELECT id, "channelId", "isActive", "encryptedLocator" FROM "StreamVariant" WHERE "sourceId" = $1 AND "channelId" = ANY($2::text[])`, [source.id, part]);
    for (const row of rows.rows) variantByChannelId.set(row.channelId, row);
  }

  const creates = [];
  const updates = [];
  const variantUpdates = [];
  const newVariantUrls = new Map();

  for (const entry of metas) {
    const existing = channelByKey.get(entry.key) ?? channelByKey.get(entry.legacyKey);
    if (!existing) {
      creates.push({ name: entry.title, canonicalName: entry.title, normalizedKey: entry.key, tvgId: entry.tvgId ?? null, country: entry.country, categorySlug: entry.categorySlug, sortOrder: entry.sortOrder });
      newVariantUrls.set(entry.key, entry.url);
      continue;
    }
    channelByKey.set(entry.key, existing);
    channelByKey.set(entry.legacyKey, existing);
    seenChannelIds.add(existing.id);
    const update = { id: existing.id, sortOrder: entry.sortOrder };
    let changed = existing.sortOrder !== entry.sortOrder;
    if (entry.tvgId && entry.tvgId !== existing.tvgId) { update.tvgId = entry.tvgId; changed = true; }
    if (entry.country && entry.country !== existing.country) { update.country = entry.country; changed = true; }
    if (entry.categorySlug && categoryBySlug.get(entry.categorySlug)?.id !== existing.categoryId) { update.categorySlug = entry.categorySlug; changed = true; }
    if (changed) updates.push(update);
    const variant = variantByChannelId.get(existing.id);
    if (variant) {
      let currentUrl = null;
      try { currentUrl = await decryptLocator(cryptoKey, variant.encryptedLocator); } catch { currentUrl = null; }
      if (currentUrl !== entry.url) variantUpdates.push({ id: variant.id, url: entry.url });
    } else {
      newVariantUrls.set(entry.key, entry.url);
    }
  }

  let sortOrderCursor = 0;
  for (const slug of categorySlugs) {
    if (categoryBySlug.has(slug)) continue;
    const created = await env.db.query(env, `INSERT INTO "Category" (id, slug, name, "sortOrder") VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id, slug, name, "sortOrder"`, [crypto.randomUUID(), slug, categoryNameBySlug.get(slug) ?? slug, sortOrderCursor]);
    categoryBySlug.set(created.rows[0].slug, created.rows[0]);
    sortOrderCursor += 1;
  }

  for (const part of chunks(creates, BATCH)) {
    const values = [];
    const params = [];
    part.forEach((entry, position) => {
      const base = position * 8;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`);
      params.push(crypto.randomUUID(), entry.name, entry.canonicalName, entry.normalizedKey, entry.tvgId, entry.country, entry.categorySlug ? categoryBySlug.get(entry.categorySlug)?.id ?? null : null, entry.sortOrder);
    });
    const inserted = await env.db.query(
      env,
      `INSERT INTO "Channel" (id, name, "canonicalName", "normalizedKey", "tvgId", country, "categoryId", "sortOrder") VALUES ${values.join(", ")}
       ON CONFLICT ("normalizedKey") DO NOTHING RETURNING id, name, "canonicalName", "normalizedKey", "tvgId", country, "categoryId", "sortOrder", "logoKey"`,
      params,
    );
    for (const row of inserted.rows) {
      channelByKey.set(row.normalizedKey, row);
      seenChannelIds.add(row.id);
      metrics.created += 1;
    }
    if (inserted.rows.length) await flush();
  }

  // logoKey = URL directe (pas de re-téléchargement en Worker).
  const logoUpdates = [];
  for (const entry of metas) {
    if (!entry.tvgLogo || !/^https?:\/\//i.test(entry.tvgLogo)) continue;
    const channel = channelByKey.get(entry.key);
    if (channel && channel.logoKey !== entry.tvgLogo) logoUpdates.push({ id: channel.id, logo: entry.tvgLogo });
    metrics.logos += 1;
  }
  for (const part of chunks(logoUpdates, 500)) {
    const values = [];
    const params = [];
    part.forEach((update, position) => {
      values.push(`($${position * 2 + 1}, $${position * 2 + 2})`);
      params.push(update.id, update.logo);
    });
    await env.db.query(
      env,
      `UPDATE "Channel" AS c SET "logoKey" = v.logo FROM (VALUES ${values.join(', ')}) AS v(id, logo) WHERE c.id = v.id`,
      params,
    );
  }

  const variantsToCreate = [];
  for (const [keyUrl, url] of newVariantUrls) {
    const channel = channelByKey.get(keyUrl);
    if (channel) variantsToCreate.push({ channelId: channel.id, url });
    else metrics.errors += 1;
  }
  for (const part of chunks(variantsToCreate, BATCH)) {
    const locators = await Promise.all(part.map((item) => encryptLocator(cryptoKey, item.url)));
    const values = [];
    const params = [];
    part.forEach((item, position) => {
      values.push(`($${position * 4 + 1}, $${position * 4 + 2}, $${position * 4 + 3}, $${position * 4 + 4})`);
      params.push(crypto.randomUUID(), item.channelId, source.id, locators[position]);
    });
    await env.db.query(env, `INSERT INTO "StreamVariant" (id, "channelId", "sourceId", "encryptedLocator") VALUES ${values.join(", ")}`, params);
    metrics.created += part.length;
    metrics.processed = Math.min(metrics.read, metrics.created + metrics.updated + metrics.duplicates + metrics.errors);
    await flush({ processed: metrics.processed });
  }

  for (const part of chunks(updates, 1000)) {
    for (const update of part) {
      await env.db.query(
        env,
        `UPDATE "Channel" SET "sortOrder" = $2, "tvgId" = COALESCE($3, "tvgId"), country = COALESCE($4, country), "categoryId" = COALESCE($5, "categoryId") WHERE id = $1`,
        [update.id, update.sortOrder, update.tvgId ?? null, update.country ?? null, update.categorySlug ? categoryBySlug.get(update.categorySlug)?.id ?? null : null],
      );
    }
  }
  for (const part of chunks(variantUpdates, 1000)) {
    for (const update of part) {
      const locator = await encryptLocator(cryptoKey, update.url);
      await env.db.query(env, `UPDATE "StreamVariant" SET "encryptedLocator" = $2, "isActive" = true WHERE id = $1`, [update.id, locator]);
    }
  }

  metrics.updated += updates.length + variantUpdates.length;
  metrics.processed = metrics.read;
  metrics.ignored = Math.max(0, metrics.read - metrics.created - metrics.updated - metrics.duplicates - metrics.errors);
  await flush();
}
