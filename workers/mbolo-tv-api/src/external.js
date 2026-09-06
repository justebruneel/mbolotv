// Titres externes publics (lecteurs tiers) : catalogue visible + détail.
// La lecture passe par /api/x/play (résolution au clic) — ici on ne sert que
// des métas et des références de lecture (finalUrl ?? embedUrl).

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function serializeSource(row) {
  return {
    id: row.id,
    host: row.host,
    mode: row.mode === 'iframe' ? 'iframe' : 'direct',
    versions: row.versions ?? [],
    playRef: row.finalUrl ?? row.embedUrl,
  };
}

export async function listExternalTitles(env, { q, limit = 48, offset = 0 } = {}) {
  const params = [];
  const conditions = [`t."isVisible" = true`];
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim()}%`);
    conditions.push(`t.title ILIKE $${params.length}`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const limitParam = Math.min(Math.max(1, Number(limit) || 48), 100);
  const offsetParam = Math.max(0, Number(offset) || 0);
  const [rows, counts] = await Promise.all([
    env.db.query(
      env,
      `SELECT t.id, t.title, t.year, t."posterUrl",
        (SELECT COUNT(*)::int FROM "ExternalSource" s
          WHERE s."titleId" = t.id AND s."isActive" AND s."lastStatus" IN ('OK','UNKNOWN')) AS "healthySources"
       FROM "ExternalTitle" t ${where}
       ORDER BY t."sortOrder" ASC, t."createdAt" DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    ),
    env.db.query(env, `SELECT COUNT(*)::int AS count FROM "ExternalTitle" t ${where}`, params),
  ]);
  const total = counts.rows[0]?.count ?? 0;
  return {
    items: rows.rows.map((row) => ({
      id: row.id,
      title: row.title,
      year: row.year ?? null,
      posterUrl: row.posterUrl ?? null,
      healthySources: row.healthySources ?? 0,
    })),
    total,
    hasMore: offsetParam + rows.rows.length < total,
  };
}

export async function findExternalTitleById(env, id) {
  const rows = await env.db.query(
    env,
    `SELECT t.id, t.title, t.year, t."posterUrl", t."backdropUrl", t."trailerYoutubeId",
      s.id AS "sourceId", s.host, s.mode, s.versions, s."embedUrl", s."finalUrl"
     FROM "ExternalTitle" t
     LEFT JOIN "ExternalSource" s
       ON s."titleId" = t.id AND s."isActive" AND s."lastStatus" IN ('OK','UNKNOWN')
     WHERE t.id = $1 AND t."isVisible" = true
     ORDER BY s."sortOrder" ASC, s."createdAt" ASC`,
    [id],
  );
  if (rows.rows.length === 0) return null;
  const first = rows.rows[0];
  return {
    id: first.id,
    title: first.title,
    year: first.year ?? null,
    posterUrl: first.posterUrl ?? null,
    backdropUrl: first.backdropUrl ?? null,
    trailerYoutubeId: first.trailerYoutubeId ?? null,
    sources: rows.rows
      .filter((row) => row.sourceId !== null)
      .map((row) => serializeSource({ id: row.sourceId, host: row.host, versions: row.versions, embedUrl: row.embedUrl, finalUrl: row.finalUrl })),
  };
}

/**
 * Balayage santé (cron) : les N sources actives les moins récemment vérifiées
 * (jamais vérifiées d'abord), résolution séquentielle (pas de rafale
 * anti-bot), statut persisté. DEAD/OK/ERROR + message tronqué.
 */
export async function checkExternalBatch(env, limit = 8) {
  const rows = await env.db.query(
    env,
    `SELECT s.id, s.host, s.mode, s."embedUrl", s."finalUrl" FROM "ExternalSource" s
     JOIN "ExternalTitle" t ON t.id = s."titleId"
     WHERE s."isActive" AND t."isVisible" = true
     ORDER BY s."lastCheckedAt" ASC NULLS FIRST LIMIT $1`,
    [Math.min(Math.max(1, Number(limit) || 8), 50)],
  );
  // Import paresseux (évite un cycle extractors ↔ external).
  const { checkEmbedPage, checkSource } = await import('./extractors/index.js');
  const summary = { checked: 0, ok: 0, dead: 0, errors: 0 };
  for (const source of rows.rows) {
    try {
      // Iframe : simple existence de la page embed (pas de handshake).
      const check = source.mode === 'iframe'
        ? await checkEmbedPage(env, source.embedUrl)
        : await checkSource(env, source.host, source.finalUrl ?? source.embedUrl);
      const status = check.ok ? 'OK' : check.code === 'DEAD' ? 'DEAD' : 'ERROR';
      await env.db.query(env, `UPDATE "ExternalSource" SET "lastStatus" = $2, "lastError" = $3, "lastCheckedAt" = now() WHERE id = $1`,
        [source.id, status, check.ok ? null : String(check.message ?? '').slice(0, 200)]);
      summary.checked += 1;
      if (check.ok) summary.ok += 1;
      else if (status === 'DEAD') summary.dead += 1;
      else summary.errors += 1;
    } catch {
      summary.checked += 1;
      summary.errors += 1;
    }
  }
  return summary;
}

export const _internal = { iso };
