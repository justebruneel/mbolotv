// Proxy vidéo edge avec sortie résidentielle optionnelle.
//
// Certains fournisseurs IPTV bloquent les IP datacenter (anti-restream) :
// pour ces hôtes seulement, les requêtes sont réinjectées vers un tunnel
// cloudflared résidentiel (RELAY_MAP : { "host:port": "https://relay…" }).
// Les redirections du fournisseur (changement de serveur média + jeton) sont
// suivies MANUELLEMENT côté Worker afin que chaque saut repasse par le relais
// — un redirect:"follow" ferait sortir le 2e saut directement de Cloudflare.

const MAX_REDIRECTS = 5;

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

    // Chaîne de requêtes en redirect:"manual", chaque saut remappé vers le
    // relais résidentiel s'il correspond à un hôte configuré.
    let originResp;
    let currentUrl = target;
    try {
      let hops = 0;
      for (;;) {
        originResp = await fetch(applyRelay(env, currentUrl), { headers, redirect: "manual" });
        const location = originResp.headers.get("location");
        if (![301, 302, 303, 307, 308].includes(originResp.status) || !location) break;
        if (++hops > MAX_REDIRECTS) {
          return new Response("Trop de redirections fournisseur", {
            status: 502,
            headers: corsHeaders(),
          });
        }
        currentUrl = new URL(location, originResp.url || currentUrl).toString();
        void originResp.body?.cancel().catch(() => undefined);
      }
    } catch {
      return new Response("Relais vidéo indisponible (machine locale éteinte ?)", {
        status: 502,
        headers: corsHeaders(),
      });
    }

    if (isPlaylist) {
      let text = await originResp.text();
      // Un vrai manifest HLS commence toujours par #EXTM3U. Les panels IPTV
      // renvoient sinon une « playlist » d'erreur (ex : « error code: 1003 » =
      // blocage des IP datacenter) : échouer clairement plutôt que servir une
      // pseudo-playlist que le lecteur ne pourra pas lire.
      if (!/^\uFEFF?\s*#EXTM3U/.test(text)) {
        return new Response(
          "Le fournisseur a refusé la requête (blocage IP datacenter ou relais indisponible)",
          {
            status: 502,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              ...corsHeaders(),
              "cache-control": "no-store",
            },
          },
        );
      }
      // Les fournisseurs Xtream redirigent souvent vers un serveur média et
      // ajoutent un jeton. Les URI de segments sont alors relatives à l'URL
      // finale, pas à l'URL Xtream initiale. Utiliser originResp.url est
      // indispensable pour que ces segments restent lisibles.
      const base = new URL(originResp.url || currentUrl || target);
      const proxyBase = `${url.origin}${url.pathname}`;

      text = text
        .split("\n")
        .map((line) => {
          if (line.startsWith("#") || line.trim() === "") return line;
          const absolute = new URL(line, base).toString();
          return `${proxyBase}?url=${encodeURIComponent(absolute)}`;
        })
        .join("\n");

      return new Response(text, {
        headers: {
          "content-type": "application/vnd.apple.mpegurl",
          ...corsHeaders(),
          "cache-control": "public, max-age=3",
        },
      });
    }

    const responseHeaders = new Headers(originResp.headers);
    responseHeaders.set("access-control-allow-origin", "*");
    responseHeaders.set("cache-control", "public, max-age=3600, immutable");

    const response = new Response(originResp.body, {
      status: originResp.status,
      headers: responseHeaders,
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
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

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
  };
}
