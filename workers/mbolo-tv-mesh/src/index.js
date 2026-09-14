// ============================================================================
// MeshStream — worker de coordination (ADR-0004, étape 3).
//
// Hors chemin critique de la vidéo : ce worker ne voit QUE des métadonnées de
// membership et du signaling. Il ne connaît ni le relay, ni le video-proxy, ni
// les fournisseurs IPTV — aucune route ne sert d'octets vidéo (test figé).
// Sa panne ne peut pas casser la lecture : le client ne reçoit qu'un champ
// optionnel de plus dans /play, que le Player actuel ignore totalement.
//
// Routes (préfixe /mesh) :
//   GET  /mesh/health          vivacité (aucune auth)
//   GET  /mesh/ws?token=       upgrade WebSocket — signaling principal, hiberné par le DO
//   POST /mesh/send?token=     montée en mode polling (mêmes enveloppes que WS)
//   GET  /mesh/poll?token=     file descendante à curseur (repli sans WebSocket)
//   POST /mesh/_admin          KICK/DRAIN d'un pair (x-admin-token = MESH_URL_SECRET)
//   GET  /mesh/_stats          compteurs agrégats (x-admin-token = MESH_URL_SECRET)
//
// Un swarm = une instance SwarmCoordinator adressée de façon déterministe par
// idFromName(swarmId) : deux clients du même swarmId arrivent TOUJOURS sur le
// même coordinateur. Le jeton est vérifié ICI (HMAC + règles temporelles) ; le
// DO ne reçoit que des en-têtes de service internes (x-mesh-pid/sid/did) — il
// n'est publiquement joignable par aucune autre voie.
// ============================================================================
import { verifyMeshToken } from "./auth.js";
import { meshConfigFromEnv } from "./config.js";
import { MESH_MAX_MESSAGE_BYTES } from "@mbolo/contracts";

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

// CORS : mêmes conventions que l'API (liste explicite, jamais de joker, liste
// vide = refus). L'upgrade WebSocket ne négocie pas de pré-vol CORS ; seul le
// polling en navigateur en a besoin.
function corsHeaders(request, env) {
  const allowed = (env?.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const origin = request.headers.get("origin");
  const headers = {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
  if (allowed.length > 0 && origin && allowed.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

async function authenticate(env, url, counters) {
  const secret = String(env.MESH_URL_SECRET ?? "").trim();
  const token = url.searchParams.get("token") ?? "";
  if (!secret) { counters.authFailures += 1; return { error: json({ error: "INTERNAL" }, 503) }; }
  const verified = await verifyMeshToken(secret, token, Date.now());
  if (!verified.ok) {
    counters.authFailures += 1;
    // Réponse uniforme : pas de distinction entre « mauvaise signature » et
    // « champ invalide » côté client — ni log de contenu.
    return { error: json({ error: verified.reason === "EXPIRED" ? "TOKEN_EXPIRED" : "INVALID_TOKEN" }, 401) };
  }
  return { payload: verified.payload };
}

function withCors(response, request, env) {
  const next = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  for (const [key, value] of Object.entries(corsHeaders(request, env))) next.headers.set(key, value);
  return next;
}

export const _internal = { corsHeaders, authenticate };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    // Compteurs d'INFRASTRUCTURE par isolate (ce que le worker sait sans
    // interroger les DO). Les compteurs applicatifs (joins, signals, pairs
    // actifs) vivent par swarm dans le DO et se lisent via /_stats?sid=.
    const counters = globalThis.__meshCounters ??
      (globalThis.__meshCounters = { polls: 0, authFailures: 0, protocolErrors: 0 });
    // Log de diagnostic : événement + route uniquement. JAMAIS le token,
    // JAMAIS une IP, JAMAIS un payload.
    const log = (event) => console.log("[mesh]", event, path);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });

    const swarms = env.MESH_SWARM;
    if (!swarms) return json({ error: "INTERNAL" }, 503, corsHeaders(request, env));

    if ((path === "/mesh/health" || path === "/") && request.method === "GET")
      return json({ status: "ok", role: "mesh-coordinator" });

    if (path === "/mesh/_stats" && request.method === "GET") {
      const admin = String(env.MESH_URL_SECRET ?? "").trim();
      if (!admin || (request.headers.get("x-admin-token") ?? "") !== admin) return json({ error: "forbidden" }, 403);
      // Diagnostic par swarm (admin) : agrégats worker + taille du swarm visé.
      const sid = url.searchParams.get("sid") ?? "";
      if (/^[0-9a-f]{32}$/.test(sid)) {
        const response = await swarms.get(swarms.idFromName(sid)).fetch(new Request("https://mesh.internal/debug", { method: "GET" }));
        const swarm = await response.json().catch(() => null);
        return json({ ...counters, p2pEnabled: meshConfigFromEnv(env).p2pEnabled, swarm });
      }
      return json({ ...counters, p2pEnabled: meshConfigFromEnv(env).p2pEnabled });
    }

    // --- Admin (x-admin-token = MESH_URL_SECRET) : pilotage à chaud d'un pair.
    // KICK : expulsion immédiate (socket fermée + fiche purgée + voisins
    // notifiés). DRAIN : le pair lit encore mais n'est plus proposé comme
    // seeder — l'arrêt progressif du seeding, sans casser sa lecture.
    if (path === "/mesh/_admin" && request.method === "POST") {
      const admin = String(env.MESH_URL_SECRET ?? "").trim();
      if (!admin || (request.headers.get("x-admin-token") ?? "") !== admin) return json({ error: "forbidden" }, 403);
      const body = await request.json().catch(() => null);
      const sid = typeof body?.sid === "string" ? body.sid : "";
      const pid = typeof body?.pid === "string" ? body.pid : "";
      const action = body?.action === "drain" ? "drain" : "kick";
      if (!/^[0-9a-f]{32}$/.test(sid) || !/^[A-Za-z0-9_-]{22}$/.test(pid)) return json({ error: "INVALID_MESSAGE" }, 400);
      const response = await swarms.get(swarms.idFromName(sid)).fetch(new Request(`https://mesh.internal/admin?action=${action}`, { method: "POST", headers: { "x-mesh-pid": pid, "x-mesh-sid": sid } }));
      return json(await response.json().catch(() => ({ ok: response.status < 400 })), response.status === 404 ? 404 : 200);
    }

    // --- WebSocket : le jeton meurt à la porte, la socket est hibernée par le DO.
    if (path === "/mesh/ws" && request.method === "GET" && (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const auth = await authenticate(env, url, counters);
      if (auth.error) return auth.error;
      const { pid, sid, did } = auth.payload;
      const stub = swarms.get(swarms.idFromName(sid));
      // Le DO route par chemin interne (/ws) ; l'URL d'origine publique n'a
      // aucune raison d'être transmise (et ne doit pas : fuite d'info inutile).
      const headers = new Headers(request.headers);
      headers.set("x-mesh-pid", pid);
      headers.set("x-mesh-sid", sid);
      headers.set("x-mesh-did", did);
      const upstream = new Request("https://mesh.internal/ws", { method: "GET", headers });
      log("ws_upgrade");
      return stub.fetch(upstream); // 101 + hibernation en aval
    }

    // --- Polling POST : mêmes enveloppes JSON que la montée WS.
    if (path === "/mesh/send" && request.method === "POST") {
      const auth = await authenticate(env, url, counters);
      if (auth.error) return auth.error;
      const raw = await request.text();
      if (raw.length > MESH_MAX_MESSAGE_BYTES) { log("oversized_message"); counters.protocolErrors += 1; return json({ error: "INVALID_MESSAGE" }, 413, corsHeaders(request, env)); }
      let message;
      try { message = JSON.parse(raw); } catch { log("bad_json"); counters.protocolErrors += 1; return json({ error: "INVALID_MESSAGE" }, 400, corsHeaders(request, env)); }
      const stub = swarms.get(swarms.idFromName(auth.payload.sid));
      const headers = new Headers({ "content-type": "application/json", "x-mesh-pid": auth.payload.pid, "x-mesh-sid": auth.payload.sid, "x-mesh-did": auth.payload.did });
      const response = await stub.fetch(new Request("https://mesh.internal/send", { method: "POST", headers, body: JSON.stringify(message) }));
      return withCors(response, request, env);
    }

    // --- Polling GET : file descendante à curseur du pair.
    if (path === "/mesh/poll" && request.method === "GET") {
      const auth = await authenticate(env, url, counters);
      if (auth.error) return auth.error;
      counters.polls += 1;
      const stub = swarms.get(swarms.idFromName(auth.payload.sid));
      const cursor = Math.max(0, Number.parseInt(url.searchParams.get("cursor") ?? "0", 10) || 0);
      const headers = new Headers({ "x-mesh-pid": auth.payload.pid, "x-mesh-sid": auth.payload.sid, "x-mesh-did": auth.payload.did });
      const response = await stub.fetch(new Request(`https://mesh.internal/poll?cursor=${cursor}`, { method: "GET", headers }));
      return withCors(response, request, env);
    }

    return json({ error: "not_found" }, 404, corsHeaders(request, env));
  },
};

export { SwarmCoordinator } from "./swarm-do.js";
