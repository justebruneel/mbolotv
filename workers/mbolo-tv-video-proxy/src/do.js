// Coordonneurs Durable Object du proxy vidéo.
//
// SEGMENT_COORDINATOR — une instance par chaîne (host + répertoire du
// fournisseur, cf. channelKeyOf) : verrou « single-flight » sur les
// cache-miss. Le premier arrivé devient « fetcher » (seul à interroger le
// fournisseur) ; les requêtes simultanées deviennent « waiters » et attendent
// la mise en cache par le fetcher au lieu de déclencher chacune leur propre
// requête. Chaque chaîne possède son propre DO : les cycles de cache restent
// indépendants entre chaînes regardées en parallèle.
//
// LIMITES (documentées) : l'état est en mémoire — une éviction du DO fait
// repartir les waiters sur un nouveau cycle via le statut « gone » (aucune
// requête client n'est perdue) ; les compteurs METRICS repartent de zéro
// après éviction ou redéploiement.
//
// METRICS — compteur global (une seule instance « global ») : requêtes reçues
// des utilisateurs vs requêtes réellement envoyées au fournisseur + hits de
// cache. Alimenté en fire-and-forget (ctx.waitUntil) : zéro latence ajoutée.
// Consultation : GET /_stats avec en-tête x-admin-token = PROXY_URL_SECRET.

const CLAIM_TTL_MS = 20_000; // > FETCH_TIMEOUT_MS (15 s) : un fetcher bloqué libère les waiters
const DONE_TTL_MS = 10_000; // mémo du résultat pour les waiters en polling

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export class SegmentCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.inflight = new Map(); // key -> { state: 'fetching' | 'done', at: number }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const key = typeof body.key === "string" ? body.key : "";
    if (!key) return jsonResponse({ error: "key manquante" }, 400);

    switch (url.pathname) {
      case "/claim": {
        this.sweep();
        const entry = this.inflight.get(key);
        if (entry && entry.state === "fetching") return jsonResponse({ role: "waiter" });
        this.inflight.set(key, { state: "fetching", at: Date.now() });
        return jsonResponse({ role: "fetcher" });
      }
      case "/release": {
        // Le fetcher a terminé (succès ou échec) : on mémorise brièvement le
        // résultat pour que les waiters en polling basculent sans course.
        this.inflight.set(key, { state: "done", at: Date.now() });
        return jsonResponse({ ok: true });
      }
      case "/check": {
        this.sweep();
        const entry = this.inflight.get(key);
        if (!entry) return jsonResponse({ state: "gone" });
        if (entry.state === "done") return jsonResponse({ state: "done" });
        return jsonResponse({ state: "pending" });
      }
      default:
        return jsonResponse({ error: "action inconnue" }, 404);
    }
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.inflight) {
      const ttl = entry.state === "fetching" ? CLAIM_TTL_MS : DONE_TTL_MS;
      if (now - entry.at > ttl) this.inflight.delete(key);
    }
  }
}

export class MetricsCounter {
  constructor(state, env) {
    this.state = state;
    this.counters = { received: 0, upstreamFetches: 0, cacheHits: 0 };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/add" && request.method === "POST") {
      const delta = await request.json().catch(() => ({}));
      for (const key of ["received", "upstreamFetches", "cacheHits"])
        if (Number.isFinite(delta[key])) this.counters[key] += delta[key];
      return jsonResponse(this.counters);
    }
    if (url.pathname === "/get") return jsonResponse(this.counters);
    if (url.pathname === "/reset" && request.method === "POST") {
      this.counters = { received: 0, upstreamFetches: 0, cacheHits: 0 };
      return jsonResponse(this.counters);
    }
    return jsonResponse({ error: "action inconnue" }, 404);
  }
}
