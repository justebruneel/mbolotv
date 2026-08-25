// Proxy vidéo edge avec sortie résidentielle optionnelle.
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target) return new Response("Missing url param", { status: 400 });

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response("Invalid url param", { status: 400 });
    }
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

    let lastFailure = null;

    for (let attempt = 0; attempt < MAX_CHAIN_ATTEMPTS; attempt += 1) {
      let outcome;
      try {
        outcome = await fetchChain(env, target, headers);
      } catch {
        lastFailure = { reason: "relais indisponible" };
        continue;
      }

      if (isPlaylist) {
        const text = await outcome.resp.text();
        // Un vrai manifest HLS commence toujours par #EXTM3U. Sinon c'est une
        // page d'erreur (du panel ou du edge Cloudflare sur un saut raté) :
        // on retente la chaîne entière, le LB changera de serveur média.
        if (!/^\uFEFF?\s*#EXTM3U/.test(text)) {
          lastFailure = {
            reason: "réponse fournisseur invalide",
            finalUrl: (outcome.finalUrl || target).slice(0, 200),
            upstreamStatus: outcome.resp.status,
            bodyHead: text.slice(0, 120),
          };
          void outcome.resp.body?.cancel().catch(() => undefined);
          continue;
        }
        const base = new URL(outcome.finalUrl || target);
        const proxyBase = `${url.origin}${url.pathname}`;
        const rewritten = text
          .split("\n")
          .map((line) => {
            if (line.startsWith("#") || line.trim() === "") return line;
            const absolute = new URL(line, base).toString();
            return `${proxyBase}?url=${encodeURIComponent(absolute)}`;
          })
          .join("\n");

        return new Response(rewritten, {
          headers: {
            "content-type": "application/vnd.apple.mpegurl",
            ...corsHeaders(),
            "cache-control": "public, max-age=3",
          },
        });
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
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }

    return new Response(
      JSON.stringify({ error: "Flux indisponible via le relais", ...(lastFailure ? { detail: lastFailure } : {}) }),
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

// Remap l'autorité d'une URL vers le relais résidentiel si l'hôte figure dans
// RELAY_MAP (JSON « host:port » → origine du relais). Les URL déjà sur un hôte
// de relais ne correspondent à aucune clé et passent telles quelles.
function applyRelay(env, targetUrl) {
  if (!env.RELAY_MAP) return targetUrl;
  try {
    const map = JSON.parse(env.RELAY_MAP);
    const parsed = new URL(targetUrl);
    const destination = map[parsed.host];
    if (!destination) return targetUrl;
    return targetUrl.replace(`${parsed.protocol}//${parsed.host}`, destination.replace(/\/+$/, ""));
  } catch {
    return targetUrl;
  }
}

async function fetchChain(env, target, headers) {
  let currentUrl = target;
  let hops = 0;
  for (;;) {
    const resp = await fetch(applyRelay(env, currentUrl), {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const location = resp.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(resp.status) || !location) {
      return { resp, finalUrl: currentUrl };
    }
    if (++hops > MAX_REDIRECTS) throw new Error("Trop de redirections fournisseur");
    currentUrl = new URL(location, resp.url || currentUrl).toString();
    void resp.body?.cancel().catch(() => undefined);
  }
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
  };
}
