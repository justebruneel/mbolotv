import { isPrivateHostname, resolveRelay } from './relay.js';

// Proxy d'images (logos de chaînes) : les logoKey sont des URLs fournisseur
// souvent injoignables (hôte mort, hotlink bloqué, http:// en mixed-content).
// On les sert depuis notre domaine, avec cache edge 7 jours.
//
// Anti-abus SANS secret : seules les URLs déjà stockées comme logoKey d'une
// chaîne en base sont proxifiées (allowlist naturelle — pas de proxy ouvert).
// + schéma http/https, pas d'hôte privé, cap 512 Ko, image/* exigé, 10 s max,
// repli via le relais résidentiel si le direct échoue.
const LOGO_MAX_BYTES = 512 * 1024;
const LOGO_FETCH_TIMEOUT_MS = 10_000;
const LOGO_CACHE_TTL_S = 7 * 24 * 3600;

function jsonError(message, status, cors = {}) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors },
  });
}

// Lecture bornée : jamais plus de LOGO_MAX_BYTES en mémoire (un serveur
// menteur sur content-length ne peut pas faire exploser l'isolate).
async function readCapped(body, maxBytes) {
  if (!body) return null;
  const reader = body.getReader();
  const parts = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) { await reader.cancel().catch(() => undefined); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

async function fetchImage(url, headers) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0', accept: 'image/*,*/*;q=0.8', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); return null; }
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) { await response.body?.cancel().catch(() => undefined); return null; }
  const bytes = await readCapped(response.body, LOGO_MAX_BYTES);
  if (!bytes) return null;
  return { bytes, contentType };
}

async function fetchLogo(env, targetUrl) {
  try {
    const direct = await fetchImage(targetUrl.toString(), {});
    if (direct) return direct;
  } catch { /* repli relais ci-dessous */ }
  const relayed = resolveRelay(env, targetUrl.toString());
  if (relayed.url === targetUrl.toString()) return null;
  try {
    return await fetchImage(relayed.url, relayed.headers);
  } catch { return null; }
}

export async function serveLogo(env, target, cors = {}) {
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return jsonError('URL invalide', 400, cors);
  }
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') return jsonError('Schéma non autorisé', 403, cors);
  if (isPrivateHostname(targetUrl.hostname)) return jsonError('Hôte interdit', 403, cors);
  // Allowlist : l'URL doit exister comme logoKey en base (requête indexable
  // par égalité ; seuls les cache-miss la paient, le cache absorbe le reste).
  let known = false;
  try {
    const rows = await env.db.query(env, `SELECT 1 FROM "Channel" WHERE "logoKey" = $1 LIMIT 1`, [target]);
    known = rows.rows.length > 0;
  } catch { known = false; }
  if (!known) return jsonError('Logo inconnu', 404, cors);
  // Upgrade http→https : le front est en https, fini le mixed-content.
  if (targetUrl.protocol === 'http:') targetUrl.protocol = 'https:';

  const cache = globalThis.caches?.default;
  const cacheKey = `https://logo.internal/?url=${encodeURIComponent(targetUrl.toString())}`;
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }
  const fetched = await fetchLogo(env, targetUrl);
  if (!fetched) return jsonError('Logo indisponible', 502, cors);
  const response = new Response(fetched.bytes, {
    status: 200,
    headers: {
      'content-type': fetched.contentType,
      'content-length': String(fetched.bytes.byteLength),
      'cache-control': `public, max-age=${LOGO_CACHE_TTL_S}`,
      ...cors,
    },
  });
  if (cache) await cache.put(new Request(cacheKey), response.clone()).catch(() => undefined);
  return response;
}

export const _internal = { LOGO_MAX_BYTES, LOGO_FETCH_TIMEOUT_MS, LOGO_CACHE_TTL_S, readCapped };
