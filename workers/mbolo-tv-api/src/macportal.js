import { resolveRelay } from './relay.js';

const MAX_API_BYTES = 50 * 1024 * 1024;
const CONNECTOR_TIMEOUT_MS = 60_000;

function arrayFrom(value) {
  if (Array.isArray(value)) return value;
  return value?.data ?? value?.results ?? value?.items ?? [];
}

function isM3uProvisioningUrl(value) {
  try {
    const url = new URL(value);
    if (/(?:^|\/)get\.php$/i.test(url.pathname)) return true;
    const type = (url.searchParams.get("type") ?? "").toLowerCase();
    return ["m3u", "m3u_plus"].includes(type);
  } catch { return false; }
}

function extractMac(value) {
  try { return new URL(value).searchParams.get("mac") ?? ""; } catch { return ""; }
}

function normalizePortalBase(value) {
  const url = new URL(value.trim());
  url.search = "";
  if (/\/portal\.php$/i.test(url.pathname)) url.pathname = url.pathname.replace(/\/portal\.php$/i, "");
  if (/\/c\/?$/i.test(url.pathname)) url.pathname = url.pathname.replace(/\/c\/?$/i, "");
  return url.toString().replace(/\/$/, "");
}

function normalizePlaybackBase(value) {
  const url = new URL(value.trim());
  url.search = "";
  if (/\/portal\.php$/i.test(url.pathname)) url.pathname = url.pathname.replace(/\/portal\.php$/i, "");
  return url.toString().replace(/\/$/, "");
}

function portalEndpoints(base) {
  const url = new URL(base);
  const origin = url.origin;
  return [...new Set([base, origin + "/stalker_portal/server", origin + "/stalker_portal", origin].map((v) => v.replace(/\/$/, "")))];
}

async function stalkerFetch(env, url, headers, timeoutMs) {
  const relayed = resolveRelay(env, url);
  // `headers` peut être une instance Headers : la détailler explicitement —
  // un spread {...headers} sur une instance donne un objet VIDE et la
  // requête partirait sans MAC/Cookie/UA (réponses 200 vides du panel).
  const merged = new Headers(headers || {});
  for (const [name, value] of Object.entries(relayed.headers)) merged.set(name, value);
  const response = await fetch(relayed.url, { headers: merged, signal: AbortSignal.timeout(timeoutMs || CONNECTOR_TIMEOUT_MS) });
  const bodyText = await response.text();
  if (bodyText.length > MAX_API_BYTES) throw new Error("Réponse trop volumineuse");
  return { ok: response.ok, status: response.status, body: bodyText };
}

export async function fetchMacPortalEntries(env, connection) {
  const rawUrl = connection.url.trim();

  // URLs get.php?type=m3u_plus : traiter comme une simple playlist M3U.
  if (isM3uProvisioningUrl(rawUrl)) {
    const response = await fetch(rawUrl, { headers: { "user-agent": "Mozilla/5.0" }, redirect: "follow", signal: AbortSignal.timeout(300000) });
    if (!response.ok || !response.body) throw new Error("Playlist MAG/M3U inaccessible");
    const text = await response.text();
    const entries = [];
    let pendingAttrs = null;
    let pendingName = "";
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("#EXTINF:")) {
        pendingAttrs = Object.fromEntries([...trimmed.matchAll(/([a-zA-Z_-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
        pendingName = trimmed.replace(/^#EXTINF:[^,]*,\s*/, "").trim();
        continue;
      }
      if (!pendingAttrs || trimmed.startsWith("#")) continue;
      entries.push({
        title: pendingAttrs["tvg-name"] || pendingName.split(";")[0]?.trim() || "Sans titre",
        tvgId: pendingAttrs["tvg-id"] || undefined,
        tvgLogo: pendingAttrs["tvg-logo"] ? (pendingAttrs["tvg-logo"].startsWith("//") ? "https:" + pendingAttrs["tvg-logo"] : pendingAttrs["tvg-logo"]) : undefined,
        groupTitle: pendingAttrs["group-title"] || undefined,
        url: trimmed,
      });
      pendingAttrs = null;
    }
    if (entries.length === 0) throw new Error("La playlist MAG/M3U ne contient aucune chaîne lisible");
    return { entries };
  }

  const base = normalizePortalBase(rawUrl);
  const playbackBase = normalizePlaybackBase(rawUrl);
  const mac = (connection.macAddress ?? extractMac(rawUrl)).trim().toUpperCase();
  if (!mac) throw new Error("Adresse MAC MAG manquante");

  const originStr = new URL(base).origin;
  const headers = new Headers({
    "MAC": String(mac),
    "Cookie": "mac=" + mac + ";stb_lang=en;timezone=UTC",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    // Certains panels (ex. mag.tiger-ott.net) réinitialisent la connexion
    // TCP sur un User-Agent inconnu : présenter l'UA de la box, comme le
    // ferait un vrai MAG — sinon chaque requête portail meurt en RST.
    "User-Agent": "Model: MAG254; Link: Ethernet",
    "X-User-Agent": "Model: MAG254; Link: Ethernet",
    "Referer": base + "/",
    "Origin": originStr,
  });

  let token = "";
  let endpoint = "";
  let lastError = "Handshake Stalker refusé";
  for (const candidate of portalEndpoints(base)) {
    try {
      const result = await stalkerFetch(env, candidate + "/portal.php?type=stb&action=handshake&token=&JsHttpRequest=1-json", headers);
      if (!result.ok || !result.body) { lastError = result.body?.slice(0, 60) || lastError; continue; }
      const payload = JSON.parse(result.body);
      if (payload.js?.token) { token = payload.js.token; endpoint = candidate; break; }
      lastError = "Aucun token Stalker";
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 80) : lastError;
    }
  }
  if (!token) throw new Error(lastError);

  const authHeaders = new Headers(headers);
  authHeaders.set("Authorization", "Bearer " + token);

  const genresById = new Map();
  try {
    const gr = await stalkerFetch(env, endpoint + "/portal.php?type=itv&action=get_genres&token=" + encodeURIComponent(token) + "&JsHttpRequest=1-json", authHeaders);
    if (gr.ok && gr.body) {
      const payload = JSON.parse(gr.body);
      for (const genre of arrayFrom(payload.js)) if (genre.id != null && genre.title) genresById.set(Number(genre.id), String(genre.title).trim());
    }
  } catch { /* facultatifs */ }

  const channelsResult = await stalkerFetch(
    env,
    endpoint + "/portal.php?type=itv&action=get_all_channels&token=" + encodeURIComponent(token) + "&JsHttpRequest=1-json",
    authHeaders,
    CONNECTOR_TIMEOUT_MS,
  );
  if (!channelsResult.ok || !channelsResult.body) throw new Error("Récupération des chaînes Stalker refusée");
  let payload;
  try { payload = JSON.parse(channelsResult.body.trim()); } catch { throw new Error("Réponse Stalker invalide"); }
  const channelList = arrayFrom(payload.js);
  if (channelList.length === 0) throw new Error("Le portail Stalker ne contient aucune chaîne");

  const entries = [];
  for (const channel of channelList) {
    if (channel.id == null) continue;
    const rawGenres = Array.isArray(channel.genres) ? channel.genres : channel.genre_id != null ? [channel.genre_id] : [];
    const genreName = rawGenres.length > 0 ? genresById.get(Number(rawGenres[0])) : undefined;
    const logo = typeof channel.logo === "string" ? (channel.logo.startsWith("//") ? "https:" + channel.logo : channel.logo) : undefined;
    entries.push({
      title: String(channel.name ?? "Chaîne " + (channel.number ?? channel.id)).trim(),
      tvgLogo: logo || undefined,
      groupTitle: genreName,
      url: playbackBase + "|" + mac + "|" + channel.id,
    });
  }
  if (entries.length === 0) throw new Error("Le portail Stalker ne contient aucune chaîne");
  return { entries };
}
