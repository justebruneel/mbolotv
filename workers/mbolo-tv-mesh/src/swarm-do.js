// ============================================================================
// SwarmCoordinator — un Durable Object PAR SWARM (ADR-0004, étape 3).
//
// Adressage : idFromName(swarmId) — déterministe : deux clients du même swarm
// atterrissent toujours ici. Ce DO ne voit JAMAIS d'octets vidéo : membership,
// heartbeat, sélection de candidats, routage de signaling (SDP opaque), config,
// purge TTL.
//
// Hibernation WebSocket (docs.cloudflare.com/durable-objects → WebSockets) :
// acceptWebSocket sans attendre de handler ; les sockets hibernées se
// récupèrent par getWebSockets() et portent leur pid en ATTACHMENT (c'est
// ainsi que le pair est retrouvé après réveil de l'isolate). L'état applicatif
// (this.peers) est en mémoire : après éviction, les clients se reconnectent et
// re-JOINent (idempotent par pid) — le membership EST éphémère par conception,
// cf. docs/architecture/meshstream.md §9. Aucune table SQLite n'est utilisée
// (précédent : SegmentCoordinator, même plan gratuit, même convention).
//
// Sécurité interne : le jeton a été vérifié par le worker AVANT routage
// (auth.js) ; x-mesh-pid/sid sont des en-têtes de service. Ici : fixation
// pid/sid sur chaque enveloppe, Zod strict, tailles bornées, rate limits,
// cap=off jamais proposé comme seeder (règle SERVEUR), routage cross-swarm
// impossible par construction (le DO ne connaît que les pid de son swarm).
// ============================================================================
import {
  meshClientMessageSchema,
  MESH_PROTOCOL_VERSION,
  MESH_MAX_MESSAGE_BYTES,
} from "@mbolo/contracts";
import {
  meshConfigFromEnv,
  HEARTBEAT_TTL_MS,
  SWEEP_INTERVAL_MS,
  SOFT_LIMIT,
  POLL_QUEUE_MAX,
  MSG_RATE_LIMIT,
} from "./config.js";

const CLOSE_REPLACED = 4000; // le même pid se re-connecte : l'ancienne socket est remplacée
const CLOSE_NORMAL = 1000;

export class SwarmCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Le swarmId RÉEL vient de l'en-tête de service (vérifié par le worker) :
    // state.id est l'identifiant dérivé par idFromName, pas le nom lui-même.
    this.swarmId = null;
    this.peers = new Map(); // pid -> PeerRecord éphémère (mémoire uniquement)
    this.downSeq = 0; // séquence des messages descendants
    this.killNotified = false; // CONFIG{p2pEnabled:false} déjà poussé aux membres ?
    this.enabledNotified = true; // pas de CONFIG{true} initial : on ne notifie la reprise qu'APRÈS une coupure (le kill met ce drapeau à false)
    this.counters = { joins: 0, leaves: 0, signals: 0, polls: 0, authFailures: 0, protocolErrors: 0, rateLimited: 0, joinRefused: 0, fallbacks: 0, stats: 0, expired: 0, signalDropped: 0 };
  }

  // ---------------------------------------------------------------- routage

  async fetch(request) {
    const url = new URL(request.url);
    const pid = request.headers.get("x-mesh-pid");
    const sid = request.headers.get("x-mesh-sid");
    // Défense interne : ces en-têtes ne sont posés QUE par ce worker, après
    // vérification HMAC du jeton — le DO n'est publiquement joignable par
    // aucune autre voie (aucune route custom, appels stub uniquement).
    if (!pid || !sid || !/^[0-9a-f]{32}$/.test(sid)) return text("bad service request", 400);
    if (this.swarmId === null) this.swarmId = sid;
    else if (sid !== this.swarmId) return text("swarm mismatch", 403); // inpossible par construction (idFromName est injectif) ; garde de collision

    if (url.pathname === "/ws") {
      if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return text("expected websocket upgrade", 426);
      const duplex = new WebSocketPair();
      const [client, server] = Object.values(duplex);
      // Remplacement propre : si ce pid possède déjà une socket (double
      // ouverture), on ferme l'ancienne — un pairId ne contrôle qu'UNE session.
      for (const stale of this.socketsOf(pid)) { try { stale.close(CLOSE_REPLACED, "replaced"); } catch {} }
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ pid });
      this.state.waitUntil(this.armSweeper());
      return switchingProtocol(client);
    }

    if (url.pathname === "/send" && request.method === "POST") {
      const raw = await request.text().catch(() => "");
      if (raw.length > MESH_MAX_MESSAGE_BYTES) { this.count("protocolErrors"); return json({ error: "INVALID_MESSAGE" }, 413); }
      let message = null;
      try { message = JSON.parse(raw); } catch { this.count("protocolErrors"); return json({ error: "INVALID_MESSAGE" }, 400); }
      await this.handle(pid, message);
      // En mode polling, la réponse descend par /poll ; le 202 est un accusé
      // de réception, jamais un contenu applicatif.
      return json({ accepted: true }, 202);
    }

    if (url.pathname === "/poll" && request.method === "GET") {
      const cursor = Math.max(0, Number.parseInt(url.searchParams.get("cursor") ?? "0", 10) || 0);
      const record = this.peers.get(pid);
      if (!record || this.isStale(record)) return json({ error: "PEER_NOT_FOUND" }); // le client re-JOINera
      record.lastSeenAt = Date.now(); // un poll est une preuve de vie
      record.pollMode = true;
      const due = record.pollQueue.filter((item) => item.n > cursor);
      if (due.length > 32) due.splice(0, due.length - 32); // au plus 32 événements par tour
      return json({ cursor: due.length ? due[due.length - 1].n : cursor, events: due.map((item) => item.raw) });
    }

    if (url.pathname === "/debug" && request.method === "GET") {
      // Diagnostic admin (aucune donnée par pair) : « combien, pas qui ».
      const byCap = { off: 0, low: 0, normal: 0 };
      for (const r of this.peers.values()) byCap[r.cap] = (byCap[r.cap] ?? 0) + 1;
      return json({ peerCount: this.peers.size, wsCount: this.state.getWebSockets().length, byCap, p2pEnabled: meshConfigFromEnv(this.env).p2pEnabled, counters: this.counters });
    }

    if (url.pathname === "/admin" && request.method === "POST") {
      // Pilotage à chaud d'UN pair (réservé au worker, x-admin-token).
      const record = this.peers.get(pid);
      if (!record) return json({ error: "PEER_NOT_FOUND" }, 404);
      if (url.searchParams.get("action") === "drain") {
        record.cap = "off";            // règle serveur : plus jamais candidat seeder
        record.win = null;
        this.sendTo(pid, "DRAIN", {}); // le pair apprend qu'il cesse de servir
        this.dropLinks(pid);           // ses voisins sont notifiés de son retrait
        return json({ ok: true, action: "drain" });
      }
      this.sendTo(pid, "KICK", { why: "admin" });
      this.peers.delete(pid);
      for (const ws of this.socketsOf(pid)) { try { ws.close(CLOSE_NORMAL, "kicked"); } catch {} }
      this.dropLinks(pid);
      this.count("kicked");
      return json({ ok: true, action: "kick" });
    }

    return text("action inconnue", 404);
  }

  // ------------------------------------------------- handlers WS hibernés

  async webSocketMessage(ws, message) {
    const { pid } = ws.deserializeAttachment() ?? {};
    if (!pid) { try { ws.close(CLOSE_NORMAL, "no-attachment"); } catch {} return; }
    if (typeof message !== "string" || message.length > MESH_MAX_MESSAGE_BYTES) {
      this.count("protocolErrors");
      try { ws.send(this.envelope("ERROR", pid, { code: "INVALID_MESSAGE" })); } catch {}
      return;
    }
    let parsed = null;
    try { parsed = JSON.parse(message); } catch { return; } // ordure binaire : on ignore, on ne nourrit pas le flood d'erreurs
    await this.handle(pid, parsed, ws);
  }

  // Fermeture de socket ≠ départ du swarm : le TTL heartbeat tranche (le pair
  // peut rouvrir une socket). Rien à purger ici — sinon un simple blip réseau
  // supprimerait un spectateur qui lit encore.
  webSocketClose() {}
  webSocketError() {}

  // ------------------------------------------------------ logique applicative

  async handle(pid, message, originWs) {
    const parsed = meshClientMessageSchema.safeParse(message);
    if (!parsed.success) { this.count("protocolErrors"); return this.sendTo(pid, "ERROR", { code: "INVALID_MESSAGE" }, originWs); }
    const msg = parsed.data;
    // Fixation d'identité : l'enveloppe doit porter le pid du porteur de la
    // connexion ET le sid de ce swarm. Usurper un pid exige de falsifier la
    // signature du jeton (le pid y est encodé à l'émission par l'API).
    if (msg.id !== pid || msg.sid !== this.swarmId) { this.count("protocolErrors"); return this.sendTo(pid, "ERROR", { code: "INVALID_MESSAGE" }, originWs); }
    if (!this.rateAllow(pid, msg.t)) { this.count("rateLimited"); return this.sendTo(pid, "ERROR", { code: "RATE_LIMITED", retryAfterMs: 2000 }, originWs); }

    switch (msg.t) {
      case "JOIN_SWARM": return this.onJoin(pid, msg.d, originWs);
      case "LEAVE_SWARM": return this.onLeave(pid);
      case "HEARTBEAT": return this.onHeartbeat(pid, msg.d);
      case "STATS_REPORT": this.peers.get(pid) && Object.assign(this.peers.get(pid), { upBytes: msg.d.upBytes, peerDlBytes: msg.d.peerDlBytes, peerOk: msg.d.peerOk, peerFail: msg.d.peerFail, rttMs: msg.d.rttMs ?? null }); this.count("stats"); return null;
      case "FALLBACK_PING": this.count("fallbacks"); return null; // télémétrie pure (mesure du gain réel)
      case "SIGNAL_OFFER":
      case "SIGNAL_ANSWER":
      case "ICE_CANDIDATE": return this.onSignal(pid, msg);
      default: this.count("protocolErrors"); return this.sendTo(pid, "ERROR", { code: "INVALID_MESSAGE" }, originWs);
    }
  }

  // -------------------------------------------------------------------- JOIN

  onJoin(pid, d, originWs) {
    const cfg = meshConfigFromEnv(this.env);
    // Kill switch actif : refus PROPRE, jamais une erreur — le client reçoit
    // simplement un swarm vide marqué désactivé et repart en origin (le Player
    // lit cfg.p2pEnabled:false et n'insiste pas).
    if (!cfg.p2pEnabled) { this.count("joinRefused"); return this.refuseWithReply(pid, originWs, "JOIN_ACCEPTED", { peers: [], cfg: { ...cfg, p2pEnabled: false } }); }
    if (d.proto < cfg.minProtocolVersion || d.proto > cfg.protocolVersion) { this.count("protocolErrors"); return this.refuseWithReply(pid, originWs, "ERROR", { code: "PROTOCOL_UNSUPPORTED" }); }
    const existing = this.peers.get(pid);
    if (!existing && this.peers.size >= SOFT_LIMIT) { this.count("joinRefused"); return this.refuseWithReply(pid, originWs, "ERROR", { code: "SWARM_FULL", retryAfterMs: 300_000 }); }
    const now = Date.now();
    this.peers.set(pid, {
      pid,
      state: "JOINING",                 // étape 3 : JOINING → CONNECTED (heartbeat) uniquement — pas de faux HEALTHY sans WebRTC
      cap: d.cap,
      net: d.net,
      rid: d.rid ?? null,
      proto: d.proto,
      win: null,
      joinedAt: existing?.joinedAt ?? now,
      lastSeenAt: now,
      // scoreMetadata PRÉPARÉE pour l'étape 5 (le scoring réel sera client) :
      upBytes: 0, peerDlBytes: 0, peerOk: 0, peerFail: 0, rttMs: null,
      pollMode: originWs ? false : existing?.pollMode ?? false,
      pollQueue: existing?.pollQueue ?? [],
      links: existing?.links ?? new Set(),
      rate: existing?.rate ?? [],
    });
    this.armSweeper(); // sync ici : on ne peut pas await dans onJoin (retour d'enveloppe) ; armSweeper interne catch tout
    this.count("joins");
    // Notification ciblée (pas de broadcast plein) : seuls les pairs qui
    // suivent ce nouveau pair — ici ses liens existants après re-JOIN.
    const record = this.peers.get(pid);
    const summary = { id: pid, cap: record.cap, win: record.win ?? undefined, rid: record.rid ?? undefined, proto: record.proto };
    for (const other of record.links) if (this.peers.has(other) && other !== pid) this.sendTo(other, "PEER_JOINED", summary);
    return this.sendTo(pid, "JOIN_ACCEPTED", { peers: this.candidates(pid), cfg }, originWs);
  }

  // ------------------------------------------------------------------- LEAVE

  onLeave(pid) {
    const record = this.peers.get(pid);
    if (!record) return null; // départ inconnu : aucune information divulguée
    this.peers.delete(pid);
    for (const ws of this.socketsOf(pid)) { try { ws.close(CLOSE_NORMAL, "left"); } catch {} }
    this.dropLinks(pid);
    this.count("leaves");
    return null;
  }

  // ---------------------------------------------------------------- HEARTBEAT

  onHeartbeat(pid, d) {
    const record = this.peers.get(pid);
    if (!record) return this.sendTo(pid, "ERROR", { code: "PEER_NOT_FOUND" }); // pair expiré entre deux tours : le client re-JOIN
    record.lastSeenAt = Date.now();
    record.state = "CONNECTED";
    record.cap = d.cap;                       // capacité toujours relue côté SERVEUR
    if (d.rid !== undefined) record.rid = d.rid;
    // Règle serveur §18 : cap=off ne publie PAS de fenêtre — un pair off ne
    // peut pas devenir seeder, même si son client l'affirme.
    const prev = record.win;
    record.win = d.cap === "off" ? null : (d.win ?? record.win ?? null);
    // Avance de fenêtre → PEER_JOINED ciblé aux abonnés (spec §2.3 : la
    // notification ne part qu'aux ≤ fan-out suiveurs, jamais un broadcast).
    if (record.win && (prev?.last !== record.win.last || prev?.cc !== record.win.cc)) {
      const summary = { id: pid, cap: record.cap, win: record.win, rid: record.rid ?? undefined, proto: record.proto };
      for (const other of record.links) if (this.peers.has(other)) this.sendTo(other, "PEER_JOINED", summary);
    }
    return null;
  }

  // ---------------------------------------------------------------- SIGNALING

  onSignal(fromPid, msg) {
    const from = this.peers.get(fromPid);
    if (!from || this.isStale(from)) { this.count("signalDropped"); return null; } // émetteur expiré/inexistant (re-JOIN perdu) : silence
    const target = this.peers.get(msg.d.to);
    if (!target || this.isStale(target)) { this.count("signalDropped"); return null; } // cible absente/expirée : l'émetteur a son propre timeout — un ERROR divulguerait la présence d'autrui
    if (msg.d.to === fromPid) { this.count("signalDropped"); return null; }
    // Routage PUR : `to` devient `from`, le SDP/ICE n'est jamais interprété.
    const data = msg.t === "ICE_CANDIDATE" ? { from: fromPid, c: msg.d.c } : { from: fromPid, sdp: msg.d.sdp };
    from.links.add(target.pid);
    target.links.add(fromPid);
    this.sendTo(target.pid, msg.t, data);
    this.count("signals");
    return null;
  }

  // ---------------------------------------------------------------- DISCOVERY

  candidates(selfPid) {
    const cfg = meshConfigFromEnv(this.env);
    const selfRid = this.peers.get(selfPid)?.rid ?? null;
    // Étape 3 : filtrage serveur simple et honnête (§16 du brief). Pas de
    // faux scoring : l'ordonnancement fin est une décision CLIENT (buffer
    // local), implémentée à l'étape 5 à partir de ces mêmes champs.
    const scored = [];
    for (const record of this.peers.values()) {
      if (record.pid === selfPid) continue;                 // jamais soi-même
      if (record.cap === "off") continue;                   // jamais une source entrante
      if (this.isStale(record)) continue;                   // expiré = inexistant
      // Renditions connues et différentes = segments incompatibles : exclu.
      // Rid inconnue (pair qui n'a pas encore switché de niveau) = neutre.
      if (selfRid && record.rid && record.rid !== selfRid) continue;
      scored.push(record);
    }
    scored.sort((a, b) => (b.win?.last ?? -1) - (a.win?.last ?? -1)); // fenêtre la plus fraîche d'abord
    return scored.slice(0, cfg.candidateSample).map((r) => ({
      id: r.pid, cap: r.cap, win: r.win ?? undefined, rid: r.rid ?? undefined, proto: r.proto,
    }));
  }

  // ------------------------------------------------------- diffusion & file

  sendTo(pid, type, data, originWs) {
    const raw = this.envelope(type, pid, data);
    const record = this.peers.get(pid);
    if (originWs) { try { originWs.send(raw); return raw; } catch {} } // réponse immédiate à la socket qui a parlé
    let sent = false;
    for (const ws of this.socketsOf(pid)) { try { ws.send(raw); sent = true; } catch {} }
    if (record && !sent) { // mode polling (ou delivery échouée) : la file garantit la livraison différée.
      // n = le seq porté par l'enveloppe (envelope() vient d'incrémenter downSeq)
      record.pollQueue.push({ n: this.downSeq, raw });
      if (record.pollQueue.length > POLL_QUEUE_MAX) record.pollQueue.shift(); // drop ancien : le pair divergent re-JOIN
    }
    return raw;
  }

  envelope(type, pid, data) {
    return JSON.stringify({ v: MESH_PROTOCOL_VERSION, t: type, sid: this.swarmId, id: pid, seq: ++this.downSeq, ts: Date.now(), d: data });
  }

  dropLinks(sourcePid) {
    const ids = [sourcePid];
    for (const record of this.peers.values()) {
      if (record.pid === sourcePid) continue;
      if (!record.links.delete(sourcePid)) continue;
      this.sendTo(record.pid, "PEER_REMOVE", { ids, why: "left" }); // ciblé : uniquement les pairs qui le connaissaient
    }
  }

  socketsOf(pid) {
    // getWebSockets() itère les sockets hibernées ; l'attachment porte le pid.
    const out = [];
    for (const ws of this.state.getWebSockets()) {
      try { if ((ws.deserializeAttachment() ?? {}).pid === pid) out.push(ws); } catch {}
    }
    return out;
  }

  // Un JOIN refusé (kill switch, protocole, swarm plein) doit QUAND MÊME être
  // livré au client. En mode WebSocket la socket existe (originWs) ; en mode
  // POLLING, sendTo n'empile la réponse que si une fiche pair existe — sinon le
  // client WebView ne reçoit jamais le refus et attend son timeout d'origine en
  // silence (défaut trouvé à l'étape 6 en test réel). On crée donc une fiche
  // « refus » éphémère : cap=off → JAMAIS candidate (candidates() l'écarte),
  // win=null → rien publié, périmée par le TTL heartbeat. Aucune information
  // durable : le membership reste éphémère par conception.
  refuseWithReply(pid, originWs, type, data) {
    if (!this.peers.has(pid) && !originWs) {
      this.peers.set(pid, {
        pid, state: "JOINING", cap: "off", net: "unknown", rid: null, proto: MESH_PROTOCOL_VERSION, win: null,
        joinedAt: Date.now(), lastSeenAt: Date.now(), upBytes: 0, peerDlBytes: 0, peerOk: 0, peerFail: 0, rttMs: null,
        pollMode: true, pollQueue: [], links: new Set(), rate: [],
      });
    }
    return this.sendTo(pid, type, data, originWs);
  }

  // ------------------------------------------------------------------ purge

  isStale(record) { return Date.now() - record.lastSeenAt > HEARTBEAT_TTL_MS; }

  async alarm() {
    const now = Date.now();
    let expired = [];
    for (const [pid, record] of this.peers) {
      if (now - record.lastSeenAt > HEARTBEAT_TTL_MS) {
        expired.push(pid);
        this.peers.delete(pid);
        for (const ws of this.socketsOf(pid)) { try { ws.close(CLOSE_NORMAL, "expired"); } catch {} }
      }
    }
    for (const pid of expired) this.dropLinks(pid);
    if (expired.length) this.count("expired", expired.length);
    const cfg = meshConfigFromEnv(this.env);
    // Transitions du kill switch (étape 5) : on notifie les DEUX bords pour
    // que les pairs en PAUSE puissent REPRENDRE sans recharger. Sans cette
    // re-notification à true, un pair mis en pause par MESH_KILL_SWITCH ne
    // saurait jamais que le P2P est revenu (il ne reçoit que le CONFIG de
    // coupure). « combien, pas qui » : un CONFIG, aucune donnée par pair.
    if (!cfg.p2pEnabled && !this.killNotified && this.peers.size > 0) {
      this.killNotified = true;
      this.enabledNotified = false;
      for (const record of this.peers.values()) this.sendTo(record.pid, "CONFIG", cfg);
    }
    if (cfg.p2pEnabled) {
      if (this.killNotified) {
        this.killNotified = false;
        this.enabledNotified = false; // force la notification de reprise ci-dessous
      }
      if (!this.enabledNotified && this.peers.size > 0) {
        this.enabledNotified = true;
        for (const record of this.peers.values()) this.sendTo(record.pid, "CONFIG", cfg);
      }
    }
    // Pas de battement d'alarme sur un swarm vide : la prochaine arrivée
    // (JOIN/WS) réarme. Un swarm actif se purge lui-même toutes les 30 s.
    if (this.peers.size > 0) await this.armSweeper();
    else { this.sweepArmed = false; try { await this.state.storage.deleteAlarm(); } catch {} }
  }

  async armSweeper() {
    // Une seule alarme planifiée par swarm (getAlarm = « déjà armé ? ») ;
    // coût : 1 réveil / 30 s / swarm actif, quelle que soit la taille.
    if (this.sweepArmed) return;
    try {
      if (await this.state.storage.getAlarm()) { this.sweepArmed = true; return; }
      await this.state.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
      this.sweepArmed = true;
    } catch { /* stockage indisponible : le prochain message ré-armera */ }
  }

  // ----------------------------------------------------- rate limit & compteurs

  rateAllow(pid, type) {
    const record = this.peers.get(pid);
    if (!record) return true; // le JOIN initial n'a pas encore de fiche : la vraie porte est l'auth du worker (HMAC) + SWARM_FULL (taille)
    const now = Date.now();
    const recent = record.rate.filter((t) => now - t < 1000);
    if (recent.length >= MSG_RATE_LIMIT) return false;
    recent.push(now);
    record.rate = recent;
    return true;
  }

  count(name, delta = 1) {
    const c = this.counters ?? (this.counters = { joins: 0, leaves: 0, signals: 0, polls: 0, authFailures: 0, protocolErrors: 0, rateLimited: 0, joinRefused: 0, fallbacks: 0, stats: 0, expired: 0, signalDropped: 0 });
    c[name] = (c[name] ?? 0) + delta;
  }
}

function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function text(value, status) { return new Response(value, { status }); }

// Réponse 101 + socket : supportée par le runtime Workers, PAS par le Response
// de Node (les tests node --test). Repli identifié pour les tests uniquement.
function switchingProtocol(webSocket) {
  try { return new Response(null, { status: 101, webSocket }); }
  catch { const response = new Response(null, { status: 200 }); response.__webSocket = webSocket; return response; }
}
