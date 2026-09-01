// Réplique de channel-health.service.ts : GET (pas HEAD) du locator déchiffré,
// plafond 1 Mo, timeout 6 s, batch + pause.
// Un manifest valide commence toujours par #EXTM3U. Les panels IPTV répondent
// sinon avec une « playlist » d'erreur en content-type mpegurl (error code:
// 1003 = IP datacenter bloquée, 1002 = connexions max…) : à marquer DOWN.
// Les fournisseurs sont rejoints via le relais résidentiel (RELAY_MAP /
// RELAY_DOMAIN_MAP / RELAY_DEFAULT_ORIGIN — voir src/relay.js), redirections
// suivies manuellement saut par saut.
import { decryptLocator } from './crypto.js';
import { resolveRelay } from './relay.js';
import { stalkerHandshake } from './play.js';

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? 6000);

// Locator Stalker (« base|mac|channelId ») : un GET direct ne peut jamais
// renvoyer #EXTM3U (lecture = handshake + jeton Bearer à la volée). On sonde
// donc le PORTAL : un handshake accepté = portail joignable + MAC valide.
// Verdict partagé par couple base|mac (cache TTL) : toutes les variantes
// d'un même portail héritent du résultat sans marteler le panel de
// handshakes — une MAC = une session sondée par fenêtre.
const stalkerHealthCache = new Map();
const STALKER_HEALTH_TTL_MS = 30 * 60_000;

async function stalkerVariantHealth(env, locator) {
  const parts = locator.split("|");
  if (parts.length !== 3) return null;
  const cacheKey = `${parts[0]}|${parts[1]}`;
  const cached = stalkerHealthCache.get(cacheKey);
  if (cached && Date.now() - cached.at < STALKER_HEALTH_TTL_MS) return cached.ok;
  const handshake = await stalkerHandshake(env, parts[0], parts[1]);
  const ok = Boolean(handshake);
  stalkerHealthCache.set(cacheKey, { ok, at: Date.now() });
  return ok;
}

async function fetchThroughRelay(env, url, timeoutMs = TIMEOUT_MS) {
  // Le load-balancer du panel peut attribuer un serveur média injoignable :
  // on retente la chaîne complète (LB réattribuera un autre serveur).
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let currentUrl = url;
    let response;
    let hops = 0;
    try {
      for (;;) {
        const relayed = resolveRelay(env, currentUrl);
        response = await fetch(relayed.url, {
          headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', ...relayed.headers },
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        const location = response.headers.get('location');
        if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
        if (++hops > MAX_REDIRECTS) throw new Error('Trop de redirections fournisseur');
        currentUrl = new URL(location, response.url || currentUrl).toString();
        void response.body?.cancel().catch(() => undefined);
      }
      return response;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Échec relais');
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
    // Variantes Stalker : sonde portail au lieu du GET manifest.
    const stalkerOk = await stalkerVariantHealth(env, url);
    if (stalkerOk !== null) {
      const status = stalkerOk ? 'OK' : 'DOWN';
      await env.db.query(env, `UPDATE "StreamVariant" SET "healthStatus" = $2, "healthCheckedAt" = now() WHERE id = $1`, [variant.id, status]);
      return status;
    }
    const response = await fetchThroughRelay(env, url);
    if (!response.ok || response.status >= 400) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) throw new Error('Trop volumineux');
    const head = new TextDecoder().decode(buffer.slice(0, Math.min(buffer.byteLength, 2048)));
    if (!/^\uFEFF?\s*#EXTM3U/.test(head)) throw new Error('Réponse fournisseur invalide (pas un manifest)');
    if (/error\s*code/i.test(head)) throw new Error('Erreur fournisseur');
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
