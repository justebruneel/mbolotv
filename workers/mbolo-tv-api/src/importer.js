import pg from 'pg';
import { importKey, encryptLocator, decryptLocator, sha256Hex } from './crypto.js';
import { slugify, detectCountry } from './normalize.js';
import { parseM3uStream } from './m3u.js';
import { fetchXtreamLiveBatches, fetchXtreamVodBatches } from './xtream.js';
import { fetchMacPortalEntries } from './macportal.js';

// Lots mémoire-bornés (dizaines de milliers d'entrées) : ingestion au fil du
// flux, jamais plus d'un lot en mémoire. Paramètres SQL : 1000×11 = 11000,
// large marge sous la limite Postgres (65535).
const BATCH = 1000;
const QUERY_BATCH = 1000;
const CRYPTO_PARALLEL = 200;
const VOD_BATCH = 1000;
const LIVE_BATCH = 1000;
const PRUNE_SCAN = 5000;
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

// Clé VOD stable par source : hash de l'URL du panel (le stream_id Xtream
// n'est unique que chez un fournisseur donné) + identifiant externe.
// Indépendant du titre : pas de churn quand le fournisseur renomme un film.
function vodNormalizedKey(kind, externalId, baseHash) {
  return `vod-${kind.toLowerCase()}-${baseHash}-${externalId}`;
}

class ImportError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function fetchWithLimits(url, { maxBytes = 512 * 1024 * 1024, timeoutMs = 300_000 } = {}) {
  let host = 'hôte inconnu';
  try { host = new URL(url).host; } catch { /* URL déjà validée par l'appelant */ }
  console.log(`[import] M3U: téléchargement ${host} (timeout ${Math.round(timeoutMs / 1000)}s)`);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    console.log(`[import] M3U: réponse ${response.status} en ${Math.round((Date.now() - startedAt) / 1000)}s`);
    if (!response.ok && response.status >= 400) throw new Error(`Échec de téléchargement (HTTP ${response.status})`);
    return response;
  } catch (error) {
    console.log(`[import] M3U: échec après ${Math.round((Date.now() - startedAt) / 1000)}s :: ${String(error?.message ?? error).slice(0, 120)}`);
    throw error;
  }
}

// Pipeline d'import fidèle à ImportProcessor. Les logos ne sont PAS
// re-téléchargés : l'URL d'origine est conservée comme logoKey (comportement
// de repli du code Nest), ce qui évite tout stockage côté Worker.
//
// Performance : UNE seule connexion Postgres pour tout l'import (le pool par
// requête paierait un handshake Hyperdrive par requête), mises à jour en masse
// (UPDATE…FROM VALUES) et déchiffrements parallélisés par lots.
export async function runSourceImport(env, sourceId, importRunId, scope = 'all') {
  const normalizedScope = scope === 'live' || scope === 'vod' ? scope : 'all';
  // Périmètre d'import : 'live' = chaînes uniquement, 'vod' = films/séries
  // uniquement (les chaînes ne sont ni lues ni élaguées), 'all' = les deux.
  // Les chaînes gardent ainsi leur import individuel, découplé de la VOD.
  const liveActive = normalizedScope !== 'vod';
  const vodActive = normalizedScope !== 'live';
  const key = await importKey(env.ENCRYPTION_KEY);
  const client = new pg.Client(env.HYPERDRIVE.connectionString);
  await client.connect();
  const q = (sql, params = []) => client.query(sql, params);

  const fail = async (code, error) => {
    const message = String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s]+/g, '[url masquée]').slice(0, 300);
    await q(`UPDATE "ImportRun" SET state = 'FAILED', "errorCode" = $2, "errorMessage" = $3, "completedAt" = now() WHERE id = $1`, [importRunId, code, message]).catch(() => undefined);
    await q(`UPDATE "Source" SET status = 'FAILED' WHERE id = $1`, [sourceId]).catch(() => undefined);
  };

  try {
    const runRows = await q(`SELECT state FROM "ImportRun" WHERE id = $1`, [importRunId]);
    const sourceRows = await q(`SELECT id, kind, status, "vodEnabled", "connectionEncrypted" FROM "Source" WHERE id = $1`, [sourceId]);
    const run = runRows.rows[0];
    const source = sourceRows.rows[0];
    if (!run || !source || run.state === 'CANCELED') return null;
    if (source.status === 'DISABLED') { await fail('SOURCE_DISABLED', new Error('Source désactivée')); return null; }

    await q(`UPDATE "ImportRun" SET state = 'FETCHING', "startedAt" = now() WHERE id = $1`, [importRunId]);
    await q(`UPDATE "Source" SET status = 'IMPORTING' WHERE id = $1`, [sourceId]);

    let connection;
    try {
      connection = JSON.parse(await decryptLocator(key, source.connectionEncrypted));
    } catch {
      throw new ImportError('DECRYPT_ERROR', 'Connexion source illisible (clé de chiffrement différente)');
    }

    const metrics = { read: 0, processed: 0, created: 0, updated: 0, duplicates: 0, ignored: 0, errors: 0, pruned: 0, logos: 0, vodRead: 0, vodCreated: 0, vodUpdated: 0, vodDuplicates: 0, vodErrors: 0, liveCursor: 0, liveDone: 0, vodSeriesCursor: 0, vodSeriesDone: 0, vodMoviesCursor: 0, vodMoviesDone: 0 };
    // Reprise par curseur : un run relancé (même id, après waitUntil tué)
    // restaure ses compteurs et saute les entrées/phases déjà ingérées au
    // lieu de tout recommencer — chaque tentative ne coûte que le travail
    // restant, donc convergence garantie même avec un plafond CPU bas.
    // Champs numériques (contrat metrics = record<number> respecté).
    const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    let saved = run.metrics ?? null;
    if (typeof saved === 'string') { try { saved = JSON.parse(saved); } catch { saved = null; } }
    metrics.liveCursor = num(saved?.liveCursor);
    metrics.liveDone = num(saved?.liveDone);
    metrics.vodSeriesCursor = num(saved?.vodSeriesCursor);
    metrics.vodSeriesDone = num(saved?.vodSeriesDone);
    metrics.vodMoviesCursor = num(saved?.vodMoviesCursor);
    metrics.vodMoviesDone = num(saved?.vodMoviesDone);
    if (metrics.liveCursor > 0 || metrics.vodSeriesCursor > 0 || metrics.vodMoviesCursor > 0) {
      console.log(`[import ${sourceId}] reprise du run (live ${metrics.liveCursor}, séries ${metrics.vodSeriesCursor}, films ${metrics.vodMoviesCursor} déjà ingérés)`);
    }
    // Phases passées PENDANT CE run : seule une phase entièrement rejouée ici
    // autorise sa purge (les sets seen* sont reconstruits à vide à chaque
    // exécution — purger sur une phase sautée désactiverait tout le catalogue).
    let livePassed = false;
    let vodSeriesPassed = false;
    let vodMoviesPassed = false;
    const seenInput = new Set();
    const seenChannelIds = new Set();
    const seenVodKeys = new Set();
    // Heartbeat embarqué dans metrics : permet au Cron de distinguer un run
    // réellement actif d'un run orphelin (waitUntil tué) sans migration de schéma.
    const metricsPayload = () => JSON.stringify({ ...metrics, heartbeatAt: new Date().toISOString() });
    const persistMetrics = () =>
      q(`UPDATE "ImportRun" SET metrics = $2 WHERE id = $1`, [importRunId, metricsPayload()]).catch(() => undefined);
    // Heartbeat throttlé pour les longues phases sans ingestion (téléchargement
    // M3U, parse) : sans lui, le cron déclarerait le run orphelin au bout de
    // 15 min et le relancerait en double.
    let lastTouchAt = 0;
    const touchThrottled = async (intervalMs = 30_000) => {
      const now = Date.now();
      if (now - lastTouchAt < intervalMs) return;
      lastTouchAt = now;
      await persistMetrics();
    };

    if (source.kind === 'M3U') {
      const url = connection.url ?? connection.playlistUrl;
      if (!url) throw new ImportError('MISSING_URL', 'URL de playlist ou fichier local manquant');
      await q(`UPDATE "ImportRun" SET state = 'PARSING' WHERE id = $1`, [importRunId]);
      const maxBytes = Number(env.IMPORT_MAX_BYTES ?? 512 * 1024 * 1024);
      const response = await fetchWithLimits(url, { maxBytes, timeoutMs: Number(env.IMPORT_FETCH_TIMEOUT_MS ?? 300_000) });
      await q(`UPDATE "ImportRun" SET state = 'NORMALIZING' WHERE id = $1`, [importRunId]);
      // Ingestion au fil du parse : jamais plus d'un lot (1000) en mémoire,
      // heartbeat pendant le téléchargement/parse, sortOrder global continu.
      // Films M3U : URLs avec extension VOD (mp4/mkv/…) → VodItem au lieu du
      // catalogue live ; group-title devient la catégorie VOD.
      const baseHash = (await sha256Hex(url)).slice(0, 8);
      let liveBatch = [];
      let vodBatch = [];
      let liveCursor = metrics.liveCursor;
      let vodCursor = metrics.vodMoviesCursor;
      let skipLive = metrics.liveCursor;
      let skipVod = metrics.vodMoviesCursor;
      const flushLive = async () => {
        if (liveBatch.length === 0) return;
        const batch = liveBatch;
        liveBatch = [];
        await ingestEntries(q, key, source, batch, metrics, seenInput, seenChannelIds, persistMetrics, liveCursor);
        liveCursor += batch.length;
        metrics.liveCursor = liveCursor;
        console.log(`[import] M3U: lot live ${batch.length} (curseur ${liveCursor})`);
        await persistMetrics();
      };
      const flushVod = async () => {
        if (vodBatch.length === 0) return;
        const batch = vodBatch;
        vodBatch = [];
        await ingestVodPhase(q, key, source, batch, metrics, persistMetrics, baseHash, seenVodKeys);
        vodCursor += batch.length;
        metrics.vodMoviesCursor = vodCursor;
        console.log(`[import] M3U: lot films ${batch.length} (curseur ${vodCursor})`);
        await persistMetrics();
      };
      console.log(`[import] M3U: parsing du flux…`);
      await parseM3uStream(response.body, (entry) => {
        // scope 'vod' : les chaînes ne sont ni lues ni ingérées.
        if (!liveActive) return;
        if (skipLive > 0) { skipLive -= 1; return; }
        metrics.read += 1;
        liveBatch.push(entry);
        if (liveBatch.length >= LIVE_BATCH) return flushLive();
      }, maxBytes, (movie) => {
        // scope 'live' : les films ne sont ni lus ni ingérés.
        if (!vodActive) return;
        if (skipVod > 0) { skipVod -= 1; return; }
        let containerExt = 'mp4';
        try { containerExt = new URL(movie.url).pathname.toLowerCase().split('.').pop() || 'mp4'; } catch { /* locator déjà validé par isVodUrl */ }
        metrics.read += 1;
        vodBatch.push({ kind: 'MOVIE', externalId: movie.url, title: movie.title, posterUrl: movie.posterUrl, rating: null, categoryTitle: movie.categoryTitle, containerExt, addedAt: null, locator: movie.url });
        if (vodBatch.length >= VOD_BATCH) return flushVod();
      }, () => touchThrottled());
      await flushLive();
      await flushVod();
      // Seules les phases réellement rejouées autorisent leur purge et sont
      // marquées terminées (un scope restreint ne doit ni élaguer ni valider
      // l'autre périmètre).
      if (liveActive) { livePassed = true; metrics.liveDone = 1; }
      if (vodActive) { vodMoviesPassed = true; metrics.vodMoviesDone = 1; }
      await persistMetrics();
      console.log(`[import] M3U: ${metrics.read} entrées parsées et ingérées`);
    } else if (source.kind === 'XTREAM') {
      if (!connection.url || !connection.username || !connection.password) throw new ImportError('MISSING_CREDENTIALS', 'Identifiants Xtream manquants');
      if (!liveActive) {
        console.log(`[import ${sourceId}] live: ignoré (scope vod — chaînes non touchées)`);
      } else if (metrics.liveDone === 1) {
        console.log(`[import ${sourceId}] live: déjà ingéré (reprise) — phase sautée`);
      } else {
        await q(`UPDATE "ImportRun" SET state = 'PARSING' WHERE id = $1`, [importRunId]);
        console.log(`[import ${sourceId}] live: catégories + get_live_streams`);
        await q(`UPDATE "ImportRun" SET state = 'NORMALIZING' WHERE id = $1`, [importRunId]);
        // Ingestion au fil du flux JSON : jamais plus d'un lot (1000) en mémoire.
        let liveCursor = metrics.liveCursor;
        let skip = metrics.liveCursor;
        if (skip > 0) console.log(`[import ${sourceId}] live: reprise (${skip} déjà ingérées)`);
        try {
          await fetchXtreamLiveBatches(env, connection, persistMetrics, async (batch) => {
            let usable = batch;
            if (skip > 0) { const drop = Math.min(skip, batch.length); usable = batch.slice(drop); skip -= drop; }
            if (usable.length === 0) return;
            metrics.read += usable.length;
            await ingestEntries(q, key, source, usable, metrics, seenInput, seenChannelIds, persistMetrics, liveCursor);
            liveCursor += usable.length;
            metrics.liveCursor = liveCursor;
            console.log(`[import ${sourceId}] live: lot ${usable.length} (curseur ${liveCursor})`);
            await persistMetrics();
          });
        } catch (error) {
          throw new ImportError('CONNECTOR_ERROR', error.message);
        }
        livePassed = true;
        metrics.liveDone = 1;
        await persistMetrics();
        console.log(`[import ${sourceId}] live: ${metrics.read} chaînes reçues et ingérées`);
        console.log(`[import ${sourceId}] live ingéré: ${JSON.stringify({ created: metrics.created, updated: metrics.updated, duplicates: metrics.duplicates, errors: metrics.errors })}`);
      }
    } else if (source.kind === 'MAC_PORTAL') {
      const url = connection.url ?? connection.portal;
      const macAddress = connection.macAddress ?? connection.mac ?? connection.mac_address;
      if (!url || !macAddress) throw new ImportError('MISSING_CREDENTIALS', 'URL ou adresse MAC manquante');
      if (!liveActive) {
        console.log(`[import ${sourceId}] MAC: ignoré (scope vod — le portail Stalker n'expose que du live)`);
      } else {
      await q(`UPDATE "ImportRun" SET state = 'PARSING' WHERE id = $1`, [importRunId]);
      let entries;
      try {
        ({ entries } = await fetchMacPortalEntries(env, { url, macAddress }));
      } catch (error) {
        throw new ImportError('CONNECTOR_ERROR', error.message);
      }
      metrics.read = entries.length;
      await persistMetrics();
      await q(`UPDATE "ImportRun" SET state = 'NORMALIZING' WHERE id = $1`, [importRunId]);
      await ingestEntries(q, key, source, entries, metrics, seenInput, seenChannelIds, persistMetrics);
      // MAC : ingestion monobloc (pas de streaming) → phases considérées
      // passées, purge autorisée.
      livePassed = true;
      vodSeriesPassed = true;
      vodMoviesPassed = true;
      metrics.liveDone = 1;
      metrics.vodSeriesDone = 1;
      metrics.vodMoviesDone = 1;
      await persistMetrics();
      }
    } else {
      throw new ImportError('UNSUPPORTED_KIND', 'Type de source non pris en charge dans le Worker');
    }

    // VOD (films/séries) : uniquement les sources XTREAM activées
    // (Source.vodEnabled). Ingestion dans VodItem en flux — chaque lot du
    // fournisseur est ingéré dès réception, le catalogue complet ne passe
    // jamais en mémoire (l'échec VOD n'invalide pas l'import du live, déjà
    // ingéré : l'erreur est enregistrée sur le run sans le marquer FAILED).
    if (source.kind === 'XTREAM' && source.vodEnabled && vodActive) {
      await q(`UPDATE "ImportRun" SET state = 'PARSING' WHERE id = $1`, [importRunId]);
      // Sous-phases indépendantes (films / séries) : un périmètre restreint
      // ('movies' ou 'series') n'active que son flux — l'autre est traité
      // comme déjà fait (ni téléchargé, ni élagué). Déjà terminées :
      // sautées (reprise) au lieu d'être retéléchargées.
      const skipSeries = !seriesActive || metrics.vodSeriesDone === 1;
      const skipMovies = !moviesActive || metrics.vodMoviesDone === 1;
      if (skipSeries && skipMovies) {
        console.log(`[import ${sourceId}] VOD: rien à télécharger (reprise ou hors périmètre)`);
      } else {
        try {
          console.log(`[import ${sourceId}] VOD: démarrage films=${moviesActive} séries=${seriesActive} (lots 500, flux via relais si 403)`);
          const baseHash = (await sha256Hex(connection.url)).slice(0, 8);
          let moviesCursor = metrics.vodMoviesCursor;
          let seriesCursor = metrics.vodSeriesCursor;
          let skipM = metrics.vodMoviesCursor;
          let skipS = metrics.vodSeriesCursor;
          await fetchXtreamVodBatches(env, connection, persistMetrics, {
            onMovies: async (batch) => {
              let usable = batch;
              if (skipM > 0) { const drop = Math.min(skipM, batch.length); usable = batch.slice(drop); skipM -= drop; }
              if (usable.length === 0) return;
              await ingestVodPhase(q, key, source, usable, metrics, persistMetrics, baseHash, seenVodKeys);
              moviesCursor += usable.length;
              metrics.vodMoviesCursor = moviesCursor;
              console.log(`[import ${sourceId}] VOD: lot films ${usable.length} (curseur ${moviesCursor})`);
              await persistMetrics();
            },
            onSeries: async (batch) => {
              let usable = batch;
              if (skipS > 0) { const drop = Math.min(skipS, batch.length); usable = batch.slice(drop); skipS -= drop; }
              if (usable.length === 0) return;
              await ingestVodPhase(q, key, source, usable, metrics, persistMetrics, baseHash, seenVodKeys);
              seriesCursor += usable.length;
              metrics.vodSeriesCursor = seriesCursor;
              console.log(`[import ${sourceId}] VOD: lot séries ${usable.length} (curseur ${seriesCursor})`);
              await persistMetrics();
            },
          }, { skipSeries, skipMovies, onPhaseDone: async (phase) => {
            // Sous-phase marquée faite DÈS sa fin (avant le flux suivant,
            // le plus lourd) : un isolate tué en plein téléchargement
            // converge à la reprise sans rejouer ce qui est déjà ingéré.
            if (phase === 'series') { vodSeriesPassed = true; metrics.vodSeriesDone = 1; }
            else { vodMoviesPassed = true; metrics.vodMoviesDone = 1; }
            await persistMetrics();
            console.log(`[import ${sourceId}] VOD: sous-phase ${phase} terminée`);
          } });
          await persistMetrics();
          console.log(`[import ${sourceId}] VOD terminé: ${JSON.stringify({ vodRead: metrics.vodRead, vodCreated: metrics.vodCreated, vodUpdated: metrics.vodUpdated, vodDuplicates: metrics.vodDuplicates, vodErrors: metrics.vodErrors })}`);
        } catch (error) {
          const message = String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s]+/g, '[url masquée]').slice(0, 300);
          console.log(`[import ${sourceId}] VOD erreur (non fatale): ${message}`);
          metrics.vodErrors += 1;
          await q(`UPDATE "ImportRun" SET "errorCode" = 'VOD_CONNECTOR_ERROR', "errorMessage" = $2 WHERE id = $1`, [importRunId, message]).catch(() => undefined);
        }
      }
    } else if (source.kind === 'XTREAM') {
      console.log(`[import ${sourceId}] VOD désactivé (vodEnabled=false) — films/séries ignorés`);
      // Rien à ingérer → phases considérées passées (la purge VOD reste
      // autorisée : elle désactivera les items d'une activation précédente).
      vodSeriesPassed = true;
      vodMoviesPassed = true;
      metrics.vodSeriesDone = 1;
      metrics.vodMoviesDone = 1;
    }

    // Prune : uniquement si la phase live a été entièrement rejouée PENDANT
    // CE run. Sur une reprise partielle, seenChannelIds est incomplet :
    // purger désactiverait à tort tout le catalogue déjà ingéré.
    if (!livePassed) {
      console.log(`[import ${sourceId}] prune live ignorée (phase incomplète — reprise ultérieure)`);
    } else {
      // Pagination par clé (id > dernier vu) : jamais tout l'historique actif
      // en RAM, et robuste aux désactivations (contrairement à OFFSET qui
      // sauterait des lignes quand le jeu se réduit entre deux pages).
      let pruneCursor = '';
      for (;;) {
        const page = await q(`SELECT id, "channelId" FROM "StreamVariant" WHERE "sourceId" = $1 AND "isActive" AND id > $2 ORDER BY id LIMIT $3`, [sourceId, pruneCursor, PRUNE_SCAN]);
        if (page.rows.length === 0) break;
        pruneCursor = page.rows[page.rows.length - 1].id;
        const toPrune = page.rows.filter((variant) => !seenChannelIds.has(variant.channelId));
        for (const part of chunks(toPrune, 500)) {
          const result = await q(`UPDATE "StreamVariant" SET "isActive" = false WHERE id = ANY($1::text[])`, [part.map((variant) => variant.id)]);
          metrics.pruned += result.rowCount;
        }
        if (page.rows.length < PRUNE_SCAN) break;
      }
    }
    // Prune VOD : même règle (les deux sous-phases séries + films doivent
    // avoir été rejouées pendant ce run).
    if (!(vodSeriesPassed && vodMoviesPassed)) {
      console.log(`[import ${sourceId}] prune VOD ignorée (phase incomplète — reprise ultérieure)`);
    } else {
      let pruneVodCursor = '';
      for (;;) {
        const page = await q(`SELECT id, "normalizedKey" FROM "VodItem" WHERE "sourceId" = $1 AND "isActive" AND id > $2 ORDER BY id LIMIT $3`, [sourceId, pruneVodCursor, PRUNE_SCAN]);
        if (page.rows.length === 0) break;
        pruneVodCursor = page.rows[page.rows.length - 1].id;
        const toPruneVod = page.rows.filter((item) => !seenVodKeys.has(item.normalizedKey));
        for (const part of chunks(toPruneVod, 500)) {
          const result = await q(`UPDATE "VodItem" SET "isActive" = false WHERE id = ANY($1::text[])`, [part.map((item) => item.id)]);
          metrics.pruned += result.rowCount;
        }
        if (page.rows.length < PRUNE_SCAN) break;
      }
    }
    metrics.processed = metrics.read;
    metrics.ignored = Math.max(0, metrics.read - (metrics.created + metrics.vodCreated) - (metrics.updated + metrics.vodUpdated) - metrics.duplicates - metrics.vodDuplicates - metrics.errors - metrics.vodErrors);

    const completed = await q(`UPDATE "ImportRun" SET state = 'COMPLETED', metrics = $2, "completedAt" = now() WHERE id = $1 AND state <> 'CANCELED' RETURNING id`, [importRunId, JSON.stringify(metrics)]);
    if (completed.rows.length > 0) {
      await q(`UPDATE "Source" SET status = 'READY', "lastSyncedAt" = now() WHERE id = $1`, [sourceId]);
      await q(
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
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function ingestEntries(q, cryptoKey, source, entries, metrics, seenInput, seenChannelIds, persistMetrics, sortOffset = 0) {
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
      metas.push({ ...entry, key: normalizedKey, legacyKey: slugify(entry.title), country, categorySlug, sortOrder: sortOffset + index + 1 });
    } catch {
      metrics.errors += 1;
    }
  }
  if (metrics.duplicates > 0) await persistMetrics();

  const lookupKeys = [...new Set(metas.flatMap((entry) => [entry.key, entry.legacyKey]))];
  const channelByKey = new Map();
  for (const part of chunks(lookupKeys, QUERY_BATCH)) {
    const rows = await q(`SELECT id, name, "canonicalName", "normalizedKey", "tvgId", country, "categoryId", "sortOrder", "logoKey" FROM "Channel" WHERE "normalizedKey" = ANY($1::text[])`, [part]);
    for (const row of rows.rows) channelByKey.set(row.normalizedKey, row);
  }
  const categoryBySlug = new Map();
  for (const part of chunks([...categorySlugs], QUERY_BATCH)) {
    const rows = await q(`SELECT id, slug, name, "sortOrder" FROM "Category" WHERE slug = ANY($1::text[])`, [part]);
    for (const row of rows.rows) categoryBySlug.set(row.slug, row);
  }

  const existingIds = [...channelByKey.values()].map((channel) => channel.id);
  const variantByChannelId = new Map();
  for (const part of chunks(existingIds, QUERY_BATCH)) {
    const rows = await q(`SELECT id, "channelId", "isActive", "encryptedLocator" FROM "StreamVariant" WHERE "sourceId" = $1 AND "channelId" = ANY($2::text[])`, [source.id, part]);
    for (const row of rows.rows) variantByChannelId.set(row.channelId, row);
  }

  const creates = [];
  const updates = [];
  const variantUpdates = [];
  const newVariantUrls = new Map();
  const decryptPairs = [];

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
    if (variant) decryptPairs.push({ variant, url: entry.url });
    else newVariantUrls.set(entry.key, entry.url);
  }

  // Déchiffrement parallélisé par lots (comparaison URL courante vs nouvelle).
  for (const part of chunks(decryptPairs, CRYPTO_PARALLEL)) {
    const currentUrls = await Promise.all(part.map((pair) => decryptLocator(cryptoKey, pair.variant.encryptedLocator).catch(() => null)));
    part.forEach((pair, index) => {
      if (currentUrls[index] !== pair.url) variantUpdates.push({ id: pair.variant.id, url: pair.url });
    });
  }

  let sortOrderCursor = 0;
  for (const slug of categorySlugs) {
    if (categoryBySlug.has(slug)) continue;
    const created = await q(`INSERT INTO "Category" (id, slug, name, "sortOrder") VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id, slug, name, "sortOrder"`, [crypto.randomUUID(), slug, categoryNameBySlug.get(slug) ?? slug, sortOrderCursor]);
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
    const inserted = await q(
      `INSERT INTO "Channel" (id, name, "canonicalName", "normalizedKey", "tvgId", country, "categoryId", "sortOrder") VALUES ${values.join(', ')}
       ON CONFLICT ("normalizedKey") DO NOTHING RETURNING id, name, "canonicalName", "normalizedKey", "tvgId", country, "categoryId", "sortOrder", "logoKey"`,
      params,
    );
    for (const row of inserted.rows) {
      channelByKey.set(row.normalizedKey, row);
      seenChannelIds.add(row.id);
      metrics.created += 1;
    }
    await persistMetrics();
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
      values.push(`($${position * 2 + 1}::text, $${position * 2 + 2}::text)`);
      params.push(update.id, update.logo);
    });
    await q(
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
    await q(`INSERT INTO "StreamVariant" (id, "channelId", "sourceId", "encryptedLocator") VALUES ${values.join(', ')}`, params);
    metrics.created += part.length;
    metrics.processed = Math.min(metrics.read, metrics.created + metrics.updated + metrics.duplicates + metrics.errors);
    await persistMetrics();
  }

  // Mises à jour canaux en masse (une requête par lot de 1000 au lieu d'une par ligne).
  for (const part of chunks(updates, 1000)) {
    const values = [];
    const params = [];
    part.forEach((update, position) => {
      const base = position * 5;
      values.push(`($${base + 1}::text, $${base + 2}::int, $${base + 3}::text, $${base + 4}::text, $${base + 5}::text)`);
      params.push(update.id, update.sortOrder, update.tvgId ?? null, update.country ?? null, update.categorySlug ? categoryBySlug.get(update.categorySlug)?.id ?? null : null);
    });
    await q(
      `UPDATE "Channel" AS c SET "sortOrder" = v.so, "tvgId" = COALESCE(v.tvg, c."tvgId"), country = COALESCE(v.ctry, c.country), "categoryId" = COALESCE(v.cat, c."categoryId")
       FROM (VALUES ${values.join(', ')}) AS v(id, so, tvg, ctry, cat) WHERE c.id = v.id`,
      params,
    );
  }
  // Variantes re-chiffrées en masse (chiffrage parallèle + un UPDATE par lot).
  for (const part of chunks(variantUpdates, CRYPTO_PARALLEL)) {
    const locators = await Promise.all(part.map((update) => encryptLocator(cryptoKey, update.url)));
    const values = [];
    const params = [];
    part.forEach((update, position) => {
      values.push(`($${position * 2 + 1}::text, $${position * 2 + 2}::bytea)`);
      params.push(update.id, locators[position]);
    });
    await q(
      `UPDATE "StreamVariant" AS sv SET "encryptedLocator" = v.loc, "isActive" = true
       FROM (VALUES ${values.join(', ')}) AS v(id, loc) WHERE sv.id = v.id`,
      params,
    );
  }

  metrics.updated += updates.length + variantUpdates.length;
  metrics.processed = metrics.read;
  metrics.ignored = Math.max(0, metrics.read - metrics.created - metrics.updated - metrics.duplicates - metrics.errors);
  await persistMetrics();
}

// Ingestion VOD (films + séries) dans VodItem — même mécanique de diff que
// ingestEntries mais table dédiée : pas de conflit de clé avec le live, pas
// de catégorie Category partagée (categoryTitle texte libre), pas de
// health-check (un mp4/mkv n'est pas un manifest #EXTM3U).
// MODE FLUX : ingestVodPhase est appelée par lot (fetchXtreamVodBatches) —
// un gros catalogue Xtream VOD dépasse 100 000 items, tout bufferiser ferait
// exploser l'isolate. Les lots films/séries sont consommés au fil de l'eau ;
// la purge VOD balaie seenVodKeys rempli au fil des lots.
export async function ingestVodPhase(q, cryptoKey, source, entries, metrics, persistMetrics, baseHash, seenVodKeys) {
  if (!entries || entries.length === 0) return;
  const metas = [];

  for (const entry of entries) {
    try {
      const normalizedKey = vodNormalizedKey(entry.kind, entry.externalId, baseHash);
      if (seenVodKeys.has(normalizedKey)) { metrics.vodDuplicates += 1; continue; }
      seenVodKeys.add(normalizedKey);
      metrics.vodRead += 1;
      metas.push({ ...entry, key: normalizedKey });
    } catch {
      metrics.vodErrors += 1;
    }
  }
  if (metrics.vodDuplicates > 0) await persistMetrics();

  const existingByKey = new Map();
  for (const part of chunks(metas.map((meta) => meta.key), QUERY_BATCH)) {
    const rows = await q(`SELECT id, kind, title, "normalizedKey", "posterUrl", rating, "categoryTitle", "containerExt", "addedAt", "isActive", "encryptedLocator" FROM "VodItem" WHERE "normalizedKey" = ANY($1::text[])`, [part]);
    for (const row of rows.rows) existingByKey.set(row.normalizedKey, row);
  }

  const creates = [];
  const updates = [];
  const reactivations = [];
  const locatorUpdates = [];
  const decryptPairs = [];

  for (const entry of metas) {
    const existing = existingByKey.get(entry.key);
    if (!existing) {
      creates.push(entry);
      continue;
    }
    // Item revenu dans le flux mais inchangé : doit être réactivé s'il avait
    // été purgé d'un import précédent (les updates plus bas ne l'auraient pas
    // touché et il serait resté isActive = false à jamais).
    if (!existing.isActive) reactivations.push(existing.id);
    const update = { id: existing.id };
    let changed = false;
    if (existing.title !== entry.title) { update.title = entry.title; changed = true; }
    if ((existing.posterUrl ?? null) !== entry.posterUrl) { update.posterUrl = entry.posterUrl; changed = true; }
    if ((existing.rating ?? null) !== entry.rating) { update.rating = entry.rating; changed = true; }
    if ((existing.categoryTitle ?? null) !== entry.categoryTitle) { update.categoryTitle = entry.categoryTitle; changed = true; }
    if ((existing.containerExt ?? null) !== entry.containerExt) { update.containerExt = entry.containerExt; changed = true; }
    const existingAdded = existing.addedAt ? new Date(existing.addedAt).getTime() : null;
    if (existingAdded !== (entry.addedAt ? entry.addedAt.getTime() : null)) { update.addedAt = entry.addedAt; changed = true; }
    if (changed) updates.push(update);
    // Locator : re-chiffré seulement s'il a réellement changé (IV aléatoire).
    decryptPairs.push({ existing, entry });
  }

  for (const part of chunks(decryptPairs, CRYPTO_PARALLEL)) {
    const currentLocators = await Promise.all(part.map((pair) => decryptLocator(cryptoKey, pair.existing.encryptedLocator).catch(() => null)));
    part.forEach((pair, index) => {
      if (currentLocators[index] !== pair.entry.locator) locatorUpdates.push({ id: pair.existing.id, locator: pair.entry.locator });
    });
  }

  await persistMetrics();

  for (const part of chunks(creates, BATCH)) {
    const locators = await Promise.all(part.map((entry) => encryptLocator(cryptoKey, entry.locator)));
    const values = [];
    const params = [];
    part.forEach((entry, position) => {
      const base = position * 11;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`);
      params.push(crypto.randomUUID(), entry.kind, entry.title, entry.key, entry.posterUrl, entry.rating, entry.categoryTitle, entry.containerExt, entry.addedAt, source.id, locators[position]);
    });
    const inserted = await q(
      `INSERT INTO "VodItem" (id, kind, title, "normalizedKey", "posterUrl", rating, "categoryTitle", "containerExt", "addedAt", "sourceId", "encryptedLocator") VALUES ${values.join(', ')}
       ON CONFLICT ("normalizedKey") DO NOTHING RETURNING id`,
      params,
    );
    metrics.vodCreated += inserted.rows.length;
    await persistMetrics();
  }

  // Mises à jour métadonnées en masse (+ réactivation des items revenue).
  for (const part of chunks(updates, 1000)) {
    const values = [];
    const params = [];
    part.forEach((update, position) => {
      const base = position * 7;
      values.push(`($${base + 1}::text, $${base + 2}::text, $${base + 3}::text, $${base + 4}::float8, $${base + 5}::text, $${base + 6}::text, $${base + 7}::timestamptz)`);
      params.push(update.id, update.title ?? null, update.posterUrl ?? null, update.rating ?? null, update.categoryTitle ?? null, update.containerExt ?? null, update.addedAt ?? null);
    });
    await q(
      `UPDATE "VodItem" AS v SET
         title = COALESCE(v2.title, v.title),
         "posterUrl" = COALESCE(v2."posterUrl", v."posterUrl"),
         rating = COALESCE(v2.rating, v.rating),
         "categoryTitle" = COALESCE(v2."categoryTitle", v."categoryTitle"),
         "containerExt" = COALESCE(v2."containerExt", v."containerExt"),
         "addedAt" = COALESCE(v2."addedAt", v."addedAt"),
         "isActive" = true
       FROM (VALUES ${values.join(', ')}) AS v2(id, title, "posterUrl", rating, "categoryTitle", "containerExt", "addedAt")
       WHERE v.id = v2.id`,
      params,
    );
  }
  metrics.vodUpdated += updates.length;

  // Réactivation en masse des items revenus sans aucun changement.
  for (const part of chunks(reactivations, 500)) {
    await q(`UPDATE "VodItem" SET "isActive" = true WHERE id = ANY($1::text[])`, [part]);
  }

  // Locators re-chiffrés en masse.
  for (const part of chunks(locatorUpdates, CRYPTO_PARALLEL)) {
    const locators = await Promise.all(part.map((update) => encryptLocator(cryptoKey, update.locator)));
    const values = [];
    const params = [];
    part.forEach((update, position) => {
      values.push(`($${position * 2 + 1}::text, $${position * 2 + 2}::bytea)`);
      params.push(update.id, locators[position]);
    });
    await q(
      `UPDATE "VodItem" AS v SET "encryptedLocator" = v2.loc, "isActive" = true
       FROM (VALUES ${values.join(', ')}) AS v2(id, loc) WHERE v.id = v2.id`,
      params,
    );
  }

  await persistMetrics();
}
