import { sha256Hex } from "./crypto.js";
import { loadHiddenIds, categoryFilterSql } from "./categories.js";
import { resolveRelay } from "./relay.js";

// Sélection identique à StreamingService.createPlay / MatchesService.play :
// variantes actives de sources non DISABLED, tri healthScore desc puis priority asc,
// première variante non DOWN préférée.
export async function selectVariant(env, channelId, filterChannelId) {
  const params = [channelId];
  let channelFilter = 'v."channelId" = $1';
  if (filterChannelId) {
    params.push(filterChannelId);
    channelFilter += ` AND c.id = $${params.length}`;
  }
  const result = await env.db.query(
    env,
    `SELECT v.id, v."encryptedLocator", v."healthScore", v."healthStatus", s.status AS source_status, s.priority AS source_priority, s.priority
     FROM "StreamVariant" v JOIN "Source" s ON s.id = v."sourceId" JOIN "Channel" c ON c.id = v."channelId"
     WHERE ${channelFilter} AND v."isActive" AND s.status <> 'DISABLED'
     ORDER BY v."healthScore" DESC, s.priority ASC`,
    params,
  );
  if (result.rows.length === 0) return null;
  return (
    result.rows.find((row) => row.healthStatus !== "DOWN") ?? result.rows[0]
  );
}

export async function assertGrantActive(env, deviceId) {
  if (!deviceId) return false;
  const deviceHash = await sha256Hex(deviceId);
  const result = await env.db.query(
    env,
    `SELECT g.id FROM "DeviceGrant" g JOIN "AccessCode" a ON a.id = g."accessCodeId"
     WHERE g."deviceHash" = $1 AND g."expiresAt" > now() AND a.active AND a."revokedAt" IS NULL LIMIT 1`,
    [deviceHash],
  );
  return result.rows.length > 0;
}

// Signature des URL de proxy : HMAC-SHA256 sur « url|expiry », même schéma que
// le proxy vidéo (PROXY_URL_SECRET partagé). L'expiry est calée sur un créneau
// horaire commun pour garder des URL stables entre utilisateurs (cache segments
// du proxy mutualisé) ; les playlists réécrites par le proxy re-signent leurs
// enfants avec le même secret.
const SIGN_TTL_MS = 24 * 3_600_000;
const SIGN_BUCKET_MS = 3_600_000;

function nextExpiry(now = Date.now()) {
  return Math.floor(now / SIGN_BUCKET_MS) * SIGN_BUCKET_MS + SIGN_TTL_MS;
}

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function playResponse(env, providerUrl, maxHeight) {
  const proxyUrl = (env.VIDEO_PROXY_URL ?? "").trim().replace(/\/+$/, "");
  if (!proxyUrl) throw new Error("VIDEO_PROXY_URL non configurée");
  const secret = typeof env.PROXY_URL_SECRET === "string" ? env.PROXY_URL_SECRET.trim() : "";
  if (!secret) throw new Error("PROXY_URL_SECRET non configurée");
  const expiry = nextExpiry();
  const signature = await hmacHex(secret, `${providerUrl}|${expiry}`);
  let url = `${proxyUrl}/?url=${encodeURIComponent(providerUrl)}&x-exp=${expiry}&x-sig=${signature}`;
  if (maxHeight) url += `&maxh=${maxHeight}`;
  return {
    url,
    expiresAt: new Date(expiry).toISOString(),
  };
}

export async function channelIsVisible(env, channelId) {
  const hiddenIds = await loadHiddenIds(env);
  const category = categoryFilterSql(hiddenIds, null, 'c', 2);
  const result = await env.db.query(
    env,
    `SELECT 1 FROM "Channel" c WHERE c.id = $1 AND c."isVisible" = true AND EXISTS (
       SELECT 1 FROM "StreamVariant" v JOIN "Source" s ON s.id = v."sourceId"
       WHERE v."channelId" = c.id AND v."isActive" AND s.status <> 'DISABLED'
     )${category.sql} LIMIT 1`,
    [channelId, ...category.params],
  );
  return result.rows.length > 0;
}

// Handshake Stalker partagé (résolution de lecture ET sonde santé) :
// teste les candidats d'endpoint et renvoie { token, endpoint }, ou null.
export async function stalkerHandshake(env, base, mac) {
  let url;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  const origin = url.origin;
  const endpoints = [...new Set([base.replace(/\/$/, ""), `${origin}/stalker_portal/server`, `${origin}/stalker_portal`, origin].map((v) => v.replace(/\/$/, "")))];

  const headers = {
    "MAC": mac,
    "Cookie": `mac=${mac};stb_lang=en;timezone=UTC`,
    "Accept": "application/json",
    // Certains panels réinitialisent la connexion sur un UA inconnu :
    // présenter l'UA de la box, comme le ferait un vrai MAG.
    "User-Agent": "Model: MAG254; Link: Ethernet",
    "X-User-Agent": "Model: MAG254; Link: Ethernet",
  };

  for (const candidate of endpoints) {
    try {
      const relayed = resolveRelay(env, `${candidate}/portal.php?type=stb&action=handshake&token=&JsHttpRequest=1-json`);
      const response = await fetch(relayed.url, {
        headers: { ...headers, ...relayed.headers },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      const payload = JSON.parse(body);
      if (payload.js?.token) return { token: String(payload.js.token), endpoint: candidate };
    } catch { continue; }
  }
  return null;
}

// Extraction de l'URL de lecture depuis un cmd Stalker (« ffmpeg http://… »),
// en échappant les « \/ » que certains panels renvoient. Une URL avec un
// `stream=` vide (panel n'ayant pas résolu le lien) est refusée.
function cmdToUrl(cmd) {
  if (!cmd) return null;
  const match = /ffmpeg\s+(\S+)/.exec(cmd.trim());
  const url = match ? match[1].replace(/\\\//g, "/") : cmd.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return /(\?|&)stream=&/.test(url) ? null : url;
}

// create_link : le cmd fourni DOIT être celui du panel (stocké dans le
// locator à l'import) — la réécriture du cmd est propre à chaque portail.
async function stalkerCreateLink(env, endpoint, cmd, token, mac) {
  const authHeaders = {
    "MAC": mac,
    "Cookie": `mac=${mac};stb_lang=en;timezone=UTC`,
    "Accept": "application/json",
    "User-Agent": "Model: MAG254; Link: Ethernet",
    "X-User-Agent": "Model: MAG254; Link: Ethernet",
    "Authorization": `Bearer ${token}`,
  };
  try {
    const relayed = resolveRelay(env, `${endpoint}/portal.php?type=itv&action=create_link&cmd=${encodeURIComponent(cmd)}&JsHttpRequest=1-json`);
    const linkResponse = await fetch(
      relayed.url,
      { headers: { ...authHeaders, ...relayed.headers }, signal: AbortSignal.timeout(15_000) },
    );
    const linkBody = await linkResponse.text();
    const linkPayload = JSON.parse(linkBody);
    return cmdToUrl(linkPayload.js?.cmd ?? "");
  } catch {
    return null;
  }
}

// Récupère le cmd le plus frais de la chaîne (get_all_channels) — son
// play_token est tout juste émis, plus valide que celui stocké à l'import.
async function fetchFreshCmd(env, endpoint, token, mac, channelId) {
  const listUrl = `${endpoint}/portal.php?type=itv&action=get_all_channels&token=${encodeURIComponent(token)}&JsHttpRequest=1-json`;
  try {
    const relayed = resolveRelay(env, listUrl);
    const response = await fetch(relayed.url, {
      headers: { "MAC": mac, "Cookie": `mac=${mac};stb_lang=en;timezone=UTC`, "Accept": "application/json", "User-Agent": "Model: MAG254; Link: Ethernet", "X-User-Agent": "Model: MAG254; Link: Ethernet", "Authorization": `Bearer ${token}`, ...relayed.headers },
      signal: AbortSignal.timeout(20_000),
    });
    const payload = JSON.parse(await response.text());
    const list = Array.isArray(payload.js) ? payload.js : payload.js?.data ?? [];
    const channel = list.find((item) => String(item.id) === String(channelId));
    return typeof channel?.cmd === "string" ? channel.cmd.trim() : "";
  } catch {
    return "";
  }
}

// Résolution dynamique des locataires Stalker MAC :
//   « {base}|{mac}|{id}|{cmd} » (import courant) → handshake + create_link(cmd).
//   « {base}|{mac}|{id} » (anciens imports) → handshake + get_all_channels
//   pour retrouver le cmd, puis create_link — lourd, en repli uniquement.
// Quand create_link échoue (stream vide — certains panels, ex. strongsat,
// refusent la réécriture), on tente la lecture DIRECTE du cmd frais : le
// proxy vidéo ira chercher cette URL telle quelle. Cela permet de lire les
// panels qui servent l'URL du cmd sans passer par create_link.
export async function resolveStalkerLocator(env, locator) {
  const parts = locator.split("|");
  if (parts.length < 3) return null;
  const [base, mac, channelId, storedCmd] = parts;

  const handshake = await stalkerHandshake(env, base, mac);
  if (!handshake) return null;
  const { token, endpoint } = handshake;

  // 1) create_link sur le cmd stocké à l'import (play_token potentiellement
  //    périmé, mais c'est le plus rapide — certains panels le réécrivent).
  if (storedCmd) {
    const direct = await stalkerCreateLink(env, endpoint, storedCmd, token, mac);
    if (direct) return direct;
  }

  // 2) Cmd FRAIS (play_token neuf, émis il y a un instant) : create_link
  //    d'abord, puis lecture directe de l'URL en dernier recours.
  const freshCmd = await fetchFreshCmd(env, endpoint, token, mac, channelId);
  if (freshCmd) {
    const link = await stalkerCreateLink(env, endpoint, freshCmd, token, mac);
    if (link) return link;
    const directUrl = cmdToUrl(freshCmd);
    if (directUrl) return directUrl;
  }

  // 3) Dernier recours : lecture directe du cmd stocké à l'import.
  if (storedCmd) {
    const directUrl = cmdToUrl(storedCmd);
    if (directUrl) return directUrl;
  }
  return null;
}
