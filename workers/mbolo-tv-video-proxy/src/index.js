// Proxy vidéo edge avec sortie résidentielle optionnelle.
//
// Accès signé : seules les URL munies d'une signature HMAC valide (x-exp +
// x-sig, voir SIGN_TTL_MS) sont servies. Le secret PROXY_URL_SECRET est
// partagé avec l'API worker (réponse /play) ; les playlists réécrites
// re-signent chaque URL enfant. Sans cela, le proxy serait un relais ouvert.
//
// Certains fournisseurs IPTV bloquent les IP datacenter (anti-restream) :
// pour ces hôtes seulement, les requêtes sont réinjectées vers un tunnel
// cloudflared résidentiel (RELAY_MAP : { "host:port": "https://relay…" }).
// Les redirections du fournisseur (changement de serveur média + jeton) sont
// suivies MANUELLEMENT côté Worker afin que chaque saut repasse par le relais
// — un redirect:"follow" ferait sortir le 2e saut directement de Cloudflare.
//
// Les panels font de la répartition de charge entre plusieurs serveurs médias,
// dont certains sont parfois injoignables depuis une ligne résidentielle :
// en cas d'échec d'une chaîne complète, on relance depuis le début — le LB
// réattribuera généralement un autre serveur.

const MAX_REDIRECTS = 5;
const MAX_CHAIN_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 15_000;

// Durcissement anti-relais ouvert : chaque URL proxifiée doit porter une
// signature HMAC-SHA256 (params x-exp + x-sig) émise par l'API (réponse /play)
// ou par ce proxy lui-même lors de la réécriture des playlists. Sans secret
// valide, aucune requête n'est servie — impossible de relayer une URL arbitraire.
// L'expiry est calée sur un créneau horaire commun pour que tous les utilisateurs
// d'une même heure partagent les mêmes URL (donc le même cache segments).
const SIGN_TTL_MS = 24 * 3_600_000;
const SIGN_BUCKET_MS = 3_600_000;

function nextExpiry(now = Date.now()) { return Math.floor(now / SIGN_BUCKET_MS) * SIGN_BUCKET_MS + SIGN_TTL_MS; }

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const _internal = { nextExpiry, hmacHex, timingSafeEqual, isIpLiteral, swapIpAuthority, applyRelay, isPrivateHostname };

function isIpLiteral(hostname) {
  // IPv4 littérale ou IPv6 (URL.hostname des URLs IPv6 garde les « : », sans crochets).
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(":");
}

// Certains panels IPTV redirigent vers un serveur média désigné par IP brute,
// parfois placé derrière Cloudflare qui refuse alors l'accès direct par IP
// (« error code: 1003 »). Réémettre la même requête avec l'autorité du saut
// précédent (le domaine du panel) fait généralement réattribuer un serveur
// joignable par le load-balancer. Retourne null quand rien à échanger.
function swapIpAuthority(currentUrl, nextUrl) {
  try {
    const next = new URL(nextUrl);
    const previous = new URL(currentUrl);
    if (!isIpLiteral(next.hostname) || isIpLiteral(previous.hostname)) return null;
    return `${previous.protocol}//${previous.host}${next.pathname}${next.search}${next.hash}`;
  } catch {
    return null;
  }
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(), "cache-control": "no-store" },
  });
}

// Plafond de qualité Éco : filtre les variantes du MASTER dont la hauteur
// dépasse maxh (garde au minimum la plus basse). Aucun transcodage : on ne
// fait que retirer des entrées #EXT-X-STREAM-INF + leur URI. Les masters
// sans RESOLUTION (mono-variante) passent intacts.
function parseHeight(infLine) {
  const match = /RESOLUTION=(\d+)x(\d+)/i.exec(infLine);
  return match ? Number(match[2]) : null;
}

function filterMasterByHeight(text, maxh) {
  if (!maxh || !text.includes("#EXT-X-STREAM-INF")) return text;
  const lines = text.split("\n");
  const variants = [];
  let pendingInf = null;
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      pendingInf = { idx, height: parseHeight(trimmed) };
      return;
    }
    if (pendingInf && trimmed !== "" && !trimmed.startsWith("#")) {
      variants.push({ ...pendingInf, uriIdx: idx });
      pendingInf = null;
    }
  });
  if (variants.length === 0) return text;

  const knownHeights = variants.map((variant) => variant.height).filter((height) => height != null);
  if (knownHeights.length === 0) return text;

  const keep = new Set();
  variants.forEach((variant, position) => {
    if (variant.height == null || variant.height <= maxh) keep.add(position);
  });
  if (keep.size === 0) {
    let minPosition = 0;
    let minHeight = Infinity;
    variants.forEach((variant, position) => {
      const height = variant.height ?? Infinity;
      if (height < minHeight) { minHeight = height; minPosition = position; }
    });
    keep.add(minPosition);
  }

  const drop = new Set();
  variants.forEach((variant, position) => {
    if (!keep.has(position)) { drop.add(variant.idx); drop.add(variant.uriIdx); }
  });
  return lines.filter((_, idx) => !drop.has(idx)).join("\n");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const secret = typeof env.PROXY_URL_SECRET === "string" ? env.PROXY_URL_SECRET.trim() : "";
    if (!secret) return jsonResponse({ error: "Proxy non configuré" }, 503);

    const target = url.searchParams.get("url");
    const expiry = Number(url.searchParams.get("x-exp"));
    const signature = url.searchParams.get("x-sig");
    if (!target || !signature || !Number.isInteger(expiry))
      return jsonResponse({ error: "Requête non signée" }, 403);
    if (Date.now() >= expiry) return jsonResponse({ error: "Signature expirée" }, 403);
    const expected = await hmacHex(secret, `${target}|${expiry}`);
    if (!timingSafeEqual(expected, signature)) return jsonResponse({ error: "Signature invalide" }, 403);

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response("Invalid url param", { status: 400 });
    }
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:")
      return jsonResponse({ error: "Schéma non autorisé" }, 403);
    // L'URL peut contenir un jeton après l'extension. Tester le pathname évite
    // de relayer une playlist HLS comme un simple fichier binaire.
    const isPlaylist = /\.m3u8?$/i.test(targetUrl.pathname);

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);

    if (!isPlaylist) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    }

    const headers = {
      "User-Agent": "Mozilla/5.0",
      ...(request.headers.get("Range") ? { Range: request.headers.get("Range") } : {}),
    };

    // Un fournisseur non cartographié (RELAY_MAP / RELAY_DOMAIN_MAP) sort par
    // le relais par défaut ; si la machine résidentielle est injoignable, on
    // retente une fois en direct avant de renoncer.
    const explicitlyMapped = applyRelay(env, target, { allowDefault: false }).upstreamAuthority !== null;

    const runAttempts = async (useDefaultRelay) => {
      let lastFailure = null;
      // Activé dès qu'un saut vers une IP brute se solde par un refus type
      // Cloudflare 1003 : les tentatives suivantes préfèrent l'autorité du domaine.
      let preferHostAuthority = false;

      for (let attempt = 0; attempt < MAX_CHAIN_ATTEMPTS; attempt += 1) {
        let outcome;
        try {
          outcome = await fetchChain(env, target, headers, { preferHostAuthority, useDefaultRelay });
        } catch (error) {
          lastFailure = { reason: "relais indisponible", erreur: String(error?.message ?? error).slice(0, 200) };
          continue;
        }

      if (isPlaylist) {
        let text = await outcome.resp.text();
        // Un vrai manifest HLS commence toujours par #EXTM3U. Sinon c'est une
        // page d'erreur (du panel ou du edge Cloudflare sur un saut raté) :
        // on retente la chaîne entière, le LB changera de serveur média.
        if (!/^\uFEFF?\s*#EXTM3U/.test(text)) {
          const finalHost = new URL(outcome.finalUrl || target).hostname;
          if (isIpLiteral(finalHost) && (outcome.resp.status === 403 || /error code:\s*\d{3}/i.test(text)))
            preferHostAuthority = true;
          lastFailure = {
            reason: "réponse fournisseur invalide",
            finalUrl: (outcome.finalUrl || target).slice(0, 200),
            upstreamStatus: outcome.resp.status,
            bodyHead: text.slice(0, 120),
          };
          void outcome.resp.body?.cancel().catch(() => undefined);
          continue;
        }
        const maxHeightParam = Number(url.searchParams.get("maxh")) || null;
        if (maxHeightParam) text = filterMasterByHeight(text, maxHeightParam);
        const base = new URL(outcome.finalUrl || target);
        const proxyBase = `${url.origin}${url.pathname}`;
        const childExpiry = nextExpiry();
        const signChild = async (absolute) =>
          `${proxyBase}?url=${encodeURIComponent(absolute)}&x-exp=${childExpiry}&x-sig=${await hmacHex(secret, `${absolute}|${childExpiry}`)}`;
        const rewrittenLines = [];
        for (const line of text.split("\n")) {
          if (line.trim() === "") { rewrittenLines.push(line); continue; }
          // Les tags à attributs (#EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF,
          // #EXT-X-KEY…) embarquent leurs URIs dans URI="…" : sans réécriture,
          // pistes audio et clés partiraient en direct vers le fournisseur
          // (CORS/relais contournés).
          if (line.startsWith("#")) {
            if (!line.includes('URI="')) { rewrittenLines.push(line); continue; }
            const resolved = new Map();
            for (const match of line.matchAll(/URI="([^"]+)"/g))
              resolved.set(match[1], await signChild(new URL(match[1], base).toString()));
            rewrittenLines.push(line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${resolved.get(uri)}"`));
            continue;
          }
          rewrittenLines.push(await signChild(new URL(line, base).toString()));
        }
        const rewritten = rewrittenLines.join("\n");

        return { response: new Response(rewritten, {
          headers: {
            "content-type": "application/vnd.apple.mpegurl",
            ...corsHeaders(),
            "cache-control": "public, max-age=3",
          },
        }) };
      }
      // Segment / fichier binaire.
      if (outcome.resp.status >= 500) {
        lastFailure = { reason: `upstream ${outcome.resp.status}` };
        void outcome.resp.body?.cancel().catch(() => undefined);
        continue;
      }
      const responseHeaders = new Headers(outcome.resp.headers);
      responseHeaders.set("access-control-allow-origin", "*");
      responseHeaders.set("cache-control", "public, max-age=3600, immutable");
      const response = new Response(outcome.resp.body, {
        status: outcome.resp.status,
        headers: responseHeaders,
      });
      // La Cache API rejette les réponses partielles (206, requêtes Range).
      if (outcome.resp.status === 200) ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return { response };
      }

      return { failure: lastFailure };
    };

    let result = await runAttempts(true);
    if (!result.response && !explicitlyMapped && env.RELAY_DEFAULT_ORIGIN)
      result = await runAttempts(false);
    if (result.response) return result.response;

    return new Response(
      JSON.stringify({ error: "Flux indisponible via le relais", ...(result.failure ? { detail: result.failure } : {}) }),
      {
        status: 502,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...corsHeaders(),
          "cache-control": "no-store",
        },
      },
    );
  },
};

function isPrivateHostname(hostname) {
  const host = String(hostname).toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (host.includes(":")) return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
  return !host.includes(".");
}

// Remap l'autorité d'une URL vers un relais résidentiel : RELAY_MAP (hôte
// exact) > RELAY_DOMAIN_MAP (suffixe domaine) > RELAY_DEFAULT_ORIGIN — tout
// fournisseur inconnu sort automatiquement par le forwarder générique
// relay-dns, aucune config à ajouter lors de l'import d'une nouvelle playlist.
// L'autorité d'origine transite via « x-upstream-authority », authentifiée
// par « x-relay-token » (secret partagé avec le forwarder local).
function applyRelay(env, targetUrl, { allowDefault = true } = {}) {
  const noRelay = { url: targetUrl, upstreamAuthority: null };
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return noRelay;
    const authority = parsed.host;
    let destination = null;
    if (env.RELAY_MAP) destination = JSON.parse(env.RELAY_MAP)[authority] ?? null;
    if (!destination && env.RELAY_DOMAIN_MAP) {
      const domainMap = JSON.parse(env.RELAY_DOMAIN_MAP);
      for (const [domain, relay] of Object.entries(domainMap)) {
        if (parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)) { destination = relay; break; }
      }
    }
    const defaultOrigin = env.RELAY_DEFAULT_ORIGIN ? String(env.RELAY_DEFAULT_ORIGIN).trim().replace(/\/+$/, "") : "";
    if (!destination && allowDefault && defaultOrigin) {
      const defaultHost = new URL(defaultOrigin).host;
      if (authority !== defaultHost && !isPrivateHostname(parsed.hostname)) destination = defaultOrigin;
    }
    if (!destination || new URL(destination).host === authority) return noRelay;
    const relayed = targetUrl.replace(`${parsed.protocol}//${parsed.host}`, destination.replace(/\/+$/, ""));
    return { url: relayed, upstreamAuthority: authority };
  } catch {
    return noRelay;
  }
}

async function fetchChain(env, target, headers, { preferHostAuthority = false, useDefaultRelay = true } = {}) {
  let currentUrl = target;
  let hops = 0;
  let swaps = 0;
  const trace = [];
  const relayToken = env.RELAY_TOKEN ? String(env.RELAY_TOKEN).trim() : "";
  for (;;) {
    const relayed = applyRelay(env, currentUrl, { allowDefault: useDefaultRelay });
    const requestHeaders = relayed.upstreamAuthority
      ? { ...headers, "x-upstream-authority": relayed.upstreamAuthority, ...(relayToken ? { "x-relay-token": relayToken } : {}) }
      : headers;
    const resp = await fetch(relayed.url, {
      headers: requestHeaders,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const location = resp.headers.get("location");
    trace.push(`${relayed.upstreamAuthority ?? new URL(currentUrl).host}#${resp.status}${location ? `>${location.slice(0, 90)}` : ""}`);
    if (![301, 302, 303, 307, 308].includes(resp.status) || !location) {
      return { resp, finalUrl: currentUrl };
    }
    if (++hops > MAX_REDIRECTS) throw new Error(`Trop de redirections fournisseur [${trace.join(" -> ")}]`);
    let nextUrl = new URL(location, resp.url || currentUrl).toString();
    // Swap borné : sans garde-fou, un panel qui réattribue toujours une IP
    // provoquerait une boucle domaine→IP→domaine jusqu'au cap de sauts.
    if (preferHostAuthority && swaps < 2) {
      const swapped = swapIpAuthority(currentUrl, nextUrl);
      if (swapped) { nextUrl = swapped; swaps += 1; }
    }
    currentUrl = nextUrl;
    void resp.body?.cancel().catch(() => undefined);
  }
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
  };
}
