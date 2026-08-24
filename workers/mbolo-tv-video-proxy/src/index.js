// src/index.js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target) return new Response("Missing url param", { status: 400 });

    const isPlaylist = target.endsWith(".m3u8");

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
      const base = new URL(target);
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
