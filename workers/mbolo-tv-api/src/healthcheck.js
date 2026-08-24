// Réplique de channel-health.service.ts : GET (pas HEAD) du locator déchiffré,
// détection playlist triple, plafond 1 Mo, timeout 6 s, batch + pause.
import { decryptLocator } from './crypto.js';

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? 6000);

function looksLikePlaylist(contentType, finalUrl, body) {
  return Boolean(
    (contentType && /mpegurl/i.test(contentType))
    || /\.m3u8?(\?|$)/i.test(finalUrl)
    || /^\s*#EXTM3U(?:\s|$)/i.test(body ?? ''),
  );
}

export async function checkVariant(env, cryptoKey, variant) {
  let url;
  try {
    url = await decryptLocator(cryptoKey, variant.encryptedLocator);
  } catch {
    await env.db.query(env, `UPDATE "StreamVariant" SET "healthStatus" = 'DOWN', "healthCheckedAt" = now() WHERE id = $1`, [variant.id]);
    return 'DOWN';
  }
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const contentType = response.headers.get('content-type') ?? undefined;
    if (!response.ok || response.status >= 400) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) throw new Error('Trop volumineux');
    const text = new TextDecoder().decode(buffer.slice(0, Math.min(buffer.byteLength, 4096)));
    if (!looksLikePlaylist(contentType, response.url || url, text)) throw new Error('Pas une playlist');
    await env.db.query(env, `UPDATE "StreamVariant" SET "healthStatus" = 'OK', "healthCheckedAt" = now() WHERE id = $1`, [variant.id]);
    return 'OK';
  } catch {
    await env.db.query(env, `UPDATE "StreamVariant" SET "healthStatus" = 'DOWN', "healthCheckedAt" = now() WHERE id = $1`, [variant.id]);
    return 'DOWN';
  }
}

export async function scanDueVariants(env, cryptoKey, batchSize = 10) {
  const since = new Date(Date.now() - 7 * 24 * 3_600_000);
  const rows = await env.db.query(
    env,
    `SELECT id, "encryptedLocator" FROM "StreamVariant"
     WHERE "lastPlayedAt" >= $1 OR "healthCheckedAt" IS NULL OR "healthStatus" = 'DOWN'
     ORDER BY "healthCheckedAt" ASC NULLS FIRST LIMIT $2`,
    [since, batchSize],
  );
  let okCount = 0;
  for (const variant of rows.rows) {
    const status = await checkVariant(env, cryptoKey, variant);
    if (status === 'OK') okCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { checked: rows.rows.length, ok: okCount };
}
