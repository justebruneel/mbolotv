// src/index.js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target) return new Response("Missing url param", { status: 400 });

    // L'URL peut contenir un jeton après l'extension. Tester le pathname évite
    // de relayer une playlist HLS comme un simple fichier binaire.
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response("Invalid url param", { status: 400 });
    }
    const isPlaylist = /\.m3u8?$/i.test(targetUrl.pathname);

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);

    if (!isPlaylist) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    }

    const originResp = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        ...(request.headers.get("Range")
          ? { Range: request.headers.get("Range") }
          : {}),
      },
    });

    if (isPlaylist) {
      let text = await originResp.text();
      // Un vrai manifest HLS commence toujours par #EXTM3U. Les panels IPTV
      // renvoient sinon une « playlist » d'erreur (ex : « error code: 1003 » =
      // blocage des IP datacenter) : échouer clairement plutôt que servir une
      // pseudo-playlist que le lecteur ne pourra pas lire.
      if (!/^\uFEFF?\s*#EXTM3U/.test(text)) {
        return new Response(
          "Le fournisseur a refusé la requête depuis le réseau edge (blocage IP datacenter probable)",
          {
            status: 502,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "access-control-allow-origin": "*",
              "cache-control": "no-store",
            },
          },
        );
      }
      // Les fournisseurs Xtream redirigent souvent vers un serveur média et
      // ajoutent un jeton. Les URI de segments sont alors relatives à l'URL
      // finale, pas à l'URL Xtream initiale. Utiliser originResp.url est
      // indispensable pour que ces segments restent lisibles.
      const base = new URL(originResp.url || target);
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
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=3",
        },
      });
    }

    const headers = new Headers(originResp.headers);
    headers.set("access-control-allow-origin", "*");
    headers.set("cache-control", "public, max-age=3600, immutable");

    const response = new Response(originResp.body, {
      status: originResp.status,
      headers,
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
