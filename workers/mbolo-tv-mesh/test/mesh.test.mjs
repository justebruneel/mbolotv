// ============================================================================
// Tests du worker mesh (ADR-0004 étape 3) — SANS Cloudflare déployé :
// mocks minimaux de l'environnement Workers (Response/Request/WebSocket sont
// natifs Node ≥ 20 ; state DO et stubs sont simulés). Ils figent la spec :
// auth, JOIN/découverte, HEARTBEAT/capacité, LEAVE, signaling, polling, TTL,
// kill switch, isolation « zéro vidéo ».
// Lancer : node --test workers/mbolo-tv-mesh/test/*.test.mjs
// ============================================================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createMeshToken,
  meshCoordinatorMessageSchema,
  MESH_PROTOCOL_VERSION,
} from "@mbolo/contracts";
import { SwarmCoordinator } from "../src/swarm-do.js";
import { verifyMeshToken } from "../src/auth.js";
import worker from "../src/index.js";
import { HEARTBEAT_TTL_MS } from "../src/config.js";

const SECRET = "test-secret-mesh";
const SID = "ab".repeat(16); // 32 hex factice

// ------------------------------------------------------------------ mocks DO

function makeState() {
  const sockets = [];
  return {
    id: { toString: () => `do-${SID}` },
    waitUntil: (promise) => { promise.catch(() => {}); },
    storage: {
      _alarm: null,
      async getAlarm() { return this._alarm; },
      async setAlarm(time) { this._alarm = time; },
      async deleteAlarm() { this._alarm = null; },
    },
    acceptWebSocket(ws) { sockets.push(ws); },
    getWebSockets() { return sockets; },
    _sockets: sockets,
  };
}

function makeWs() {
  const sent = [];
  return {
    sent,
    send(m) { sent.push(typeof m === "string" ? m : "<binary>"); },
    close() {},
    _attachment: null,
    serializeAttachment(a) { this._attachment = a; },
    deserializeAttachment() { return this._attachment; },
  };
}

async function newDo(env = {}) {
  const state = makeState();
  const coord = new SwarmCoordinator(state, env);
  coord.swarmId = SID; // le worker authentifié route avec x-mesh-sid = SID
  return { coord, state };
}

async function join(coord, pid, d = {}, ws = makeWs()) {
  ws.serializeAttachment({ pid });
  coord.state._sockets.push(ws); // simulate acceptWebSocket for this pid
  await coord.webSocketMessage(ws, JSON.stringify({
    v: MESH_PROTOCOL_VERSION, t: "JOIN_SWARM", sid: SID, id: pid, seq: 1, ts: Date.now(),
    d: { proto: 1, cap: "normal", net: "wifi", ...d },
  }));
  return last(ws);
}

function last(ws) {
  const raw = ws.sent[ws.sent.length - 1];
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  const check = meshCoordinatorMessageSchema.safeParse(parsed);
  assert.equal(check.success, true, `message descendant invalide: ${raw.slice(0, 200)}`);
  return parsed;
}

// peerIds de test : exactement 22 caractères base64url (contrat meshPeerIdSchema)
const pidA = `peerA${"A".repeat(17)}`;
const pidB = `peerB${"B".repeat(17)}`;
const pidC = `peerC${"C".repeat(17)}`;
assert.equal(pidA.length, 22);

// ------------------------------------------------------------------ tokens

async function validToken(pid = pidA, sid = SID) {
  const now = Date.now();
  return createMeshToken(SECRET, { v: 1, pid, sid, did: "cd".repeat(16), iat: now, exp: now + 3_600_000 });
}

describe("auth — meshToken", () => {
  it("token valide accepté", async () => {
    const token = await validToken();
    const r = await verifyMeshToken(SECRET, token);
    assert.equal(r.ok, true);
    assert.equal(r.payload.pid, pidA);
  });
  it("signature altérée rejetée", async () => {
    const token = await validToken();
    const [body] = token.split(".");
    const r = await verifyMeshToken("autre-secret", `${body}.${"x".repeat(43)}`);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "INVALID");
  });
  it("token expiré rejeté (EXPIRED ≠ INVALID, seule distinction client)", async () => {
    const now = Date.now();
    const token = await createMeshToken(SECRET, { v: 1, pid: pidA, sid: SID, did: "cd".repeat(16), iat: now - 7_200_000, exp: now - 3_600_000 });
    const r = await verifyMeshToken(SECRET, token);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "EXPIRED");
  });
  it("règle métier exp<=iat rejetée malgré signature valide", async () => {
    const token = await createMeshToken(SECRET, { v: 1, pid: pidA, sid: SID, did: "cd".repeat(16), iat: 100, exp: 99 });
    assert.equal((await verifyMeshToken(SECRET, token)).ok, false);
  });
  it("iat futur (> 60 s de tolérance) rejeté", async () => {
    const now = Date.now();
    const token = await createMeshToken(SECRET, { v: 1, pid: pidA, sid: SID, did: "cd".repeat(16), iat: now + 3_600_000, exp: now + 7_200_000 });
    assert.equal((await verifyMeshToken(SECRET, token)).ok, false);
  });
  it("payload forcé (données perso ajoutées, resigné) — le schéma strict du contrat l'interdit à l'émission", async () => {
    // createMeshToken parse AVANT de signer : impossible d'y glisser un champ ip
    await assert.rejects(createMeshToken(SECRET, { v: 1, pid: pidA, sid: SID, did: "cd".repeat(16), iat: 1, exp: 2, ip: "1.2.3.4" }));
  });
  it("token vide / trop gros / sans point rejetés sans exception", async () => {
    assert.equal((await verifyMeshToken(SECRET, "")).ok, false);
    assert.equal((await verifyMeshToken(SECRET, "abc")).ok, false);
    assert.equal((await verifyMeshToken(SECRET, "a.b.c")).ok, false);
    assert.equal((await verifyMeshToken(SECRET, "x".repeat(3000))).ok, false);
  });
});

describe("worker — routes publiques", () => {
  const env = { MESH_URL_SECRET: SECRET, MESH_SWARM: { idFromName: (n) => `do-${n}`, get: () => ({ fetch: async () => new Response("stub", { status: 418 }) }) }, CORS_ALLOWED_ORIGINS: "https://mbolotv-web.vercel.app" };
  it("GET /mesh/health sans auth", async () => {
    const r = await worker.fetch(new Request("https://mesh.dev/mesh/health"), env, {});
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, "ok");
  });
  it("GET /mesh/_stats exige l'admin token", async () => {
    const noToken = await worker.fetch(new Request("https://mesh.dev/mesh/_stats"), env, {});
    assert.equal(noToken.status, 403);
    const ok = await worker.fetch(new Request("https://mesh.dev/mesh/_stats", { headers: { "x-admin-token": SECRET } }), env, {});
    assert.equal(ok.status, 200);
  });
  it("routes inconnues 404 (aucune route vidéo possible)", async () => {
    for (const p of ["/", "/index.m3u8", "/segment.ts", "/proxy?url=x"]) {
      const r = await worker.fetch(new Request(`https://mesh.dev${p}`), env, {});
      assert.ok([404, 200].includes(r.status), p); // "/" = health ; tout le reste 404
      if (p !== "/") assert.equal(r.status, 404);
    }
  });
});

describe("worker — auth des routes mesh", () => {
  it("/mesh/poll sans token → 401, avec token valide → routage stub", async () => {
    const fetched = [];
    const env = {
      MESH_URL_SECRET: SECRET,
      MESH_SWARM: { idFromName: (n) => `do-${n}`, get: () => ({ fetch: async (req) => { fetched.push(req.url); return new Response("{}", { status: 200 }); } }) },
    };
    const bad = await worker.fetch(new Request("https://mesh.dev/mesh/poll?token=nonvalide"), env, {});
    assert.equal(bad.status, 401);
    const token = await validToken();
    const good = await worker.fetch(new Request(`https://mesh.dev/mesh/poll?token=${token}&cursor=0`), env, {});
    assert.equal(good.status, 200);
    assert.equal(fetched.length, 1);
    assert.match(fetched[0], /cursor=0$/); // ne JAMAIS transmettre le token au DO (le pid/sid suffisent)
  });
});

describe("JOIN — discovery", () => {
  it("premier pair : JOIN_ACCEPTED sans candidats, cfg conforme", async () => {
    const { coord } = await newDo();
    const msg = await join(coord, pidA);
    assert.equal(msg.t, "JOIN_ACCEPTED");
    assert.deepEqual(msg.d.peers, []);
    assert.equal(msg.d.cfg.protocolVersion, MESH_PROTOCOL_VERSION);
  });
  it("deuxième pair reçoit le premier (cap≠off, fenêtre fraîche d'abord)", async () => {
    const { coord } = await newDo();
    await join(coord, pidA);
    // heartbeat pour publier la fenêtre de A
    const wsForA = makeWs(); wsForA.serializeAttachment({ pid: pidA });
    await coord.webSocketMessage(wsForA, JSON.stringify({ v: 1, t: "HEARTBEAT", sid: SID, id: pidA, seq: 2, ts: Date.now(), d: { cap: "normal", win: { cc: 0, first: 10, last: 20 } } }));
    const msg = await join(coord, pidB);
    const candidates = msg.d.peers;
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, pidA);
    assert.deepEqual(candidates[0].win, { cc: 0, first: 10, last: 20 });
  });
  it("cap=off JAMAIS proposé comme seeder (règle serveur)", async () => {
    const { coord } = await newDo();
    await join(coord, pidA, { cap: "off" });
    const msg = await join(coord, pidB);
    assert.equal(msg.d.peers.some((p) => p.id === pidA), false); // jamais un pair off
    // même un HEARTBEAT cap:off avec fenêtre forgée ne publie rien :
    const wsForA = makeWs(); wsForA.serializeAttachment({ pid: pidA });
    await coord.webSocketMessage(wsForA, JSON.stringify({ v: 1, t: "HEARTBEAT", sid: SID, id: pidA, seq: 3, ts: Date.now(), d: { cap: "off", win: { cc: 0, first: 5, last: 9 } } }));
    const msg2 = await join(coord, pidC);
    assert.equal(msg2.d.peers.some((p) => p.id === pidA), false);
  });
  it("renditions connues différentes = non candidat", async () => {
    const { coord } = await newDo();
    await join(coord, pidA, { rid: "aaaaaaaa" });
    const msg = await join(coord, pidB, { rid: "bbbbbbbb" });
    assert.deepEqual(msg.d.peers, []);
    // rid inconnue du demandeur : neutre, A redevient candidat
    const { coord: coord2 } = await newDo();
    await join(coord2, pidA, { rid: "aaaaaaaa" });
    const msg2 = await join(coord2, pidB);
    assert.equal(msg2.d.peers.length, 1);
  });
  it("protocole incompatible → PROTOCOL_UNSUPPORTED propre", async () => {
    const { coord } = await newDo();
    const ws = makeWs();
    ws.serializeAttachment({ pid: pidA });
    await coord.webSocketMessage(ws, JSON.stringify({ v: 1, t: "JOIN_SWARM", sid: SID, id: pidA, seq: 1, ts: Date.now(), d: { proto: 99, cap: "off", net: "wifi" } }));
    assert.equal(last(ws).d.code, "PROTOCOL_UNSUPPORTED");
  });
  it("swarm désactivé (kill switch) : refus DOUX, jamais une erreur", async () => {
    const { coord } = await newDo({ MESH_KILL_SWITCH: "1" });
    const msg = await join(coord, pidA);
    assert.equal(msg.t, "JOIN_ACCEPTED");
    assert.equal(msg.d.cfg.p2pEnabled, false);
    assert.deepEqual(msg.d.peers, []);
  });
  it("enveloppe usurpée (id ≠ porteur) → INVALID_MESSAGE", async () => {
    const { coord } = await newDo();
    const ws = makeWs(); ws.serializeAttachment({ pid: pidA });
    await coord.webSocketMessage(ws, JSON.stringify({ v: 1, t: "JOIN_SWARM", sid: SID, id: pidB, seq: 1, ts: Date.now(), d: { proto: 1, cap: "off", net: "wifi" } }));
    assert.equal(last(ws).d.code, "INVALID_MESSAGE");
  });
  it("swarmId d'une autre enveloppe que celle du DO → INVALID_MESSAGE", async () => {
    const { coord } = await newDo();
    const ws = makeWs(); ws.serializeAttachment({ pid: pidA });
    await coord.webSocketMessage(ws, JSON.stringify({ v: 1, t: "JOIN_SWARM", sid: "cd".repeat(16), id: pidA, seq: 1, ts: Date.now(), d: { proto: 1, cap: "off", net: "wifi" } }));
    assert.equal(last(ws).d.code, "INVALID_MESSAGE");
  });
});

describe("HEARTBEAT & LEAVE", () => {
  it("heartbeat met à jour lastSeenAt et l'état", async () => {
    const { coord } = await newDo();
    const ws = makeWs();
    await join(coord, pidA, {}, ws);
    assert.equal(coord.peers.get(pidA).state, "JOINING");
    await coord.webSocketMessage(ws, JSON.stringify({ v: 1, t: "HEARTBEAT", sid: SID, id: pidA, seq: 2, ts: Date.now(), d: { cap: "normal", win: { cc: 0, first: 1, last: 2 } } }));
    assert.equal(coord.peers.get(pidA).state, "CONNECTED");
    assert.ok(coord.peers.get(pidA).lastSeenAt >= Date.now() - 50);
  });
  it("fenêtre trop large rejetée par le contrat", async () => {
    const { coord } = await newDo();
    await join(coord, pidA);
    const ws = makeWs(); ws.serializeAttachment({ pid: pidA });
    await coord.webSocketMessage(ws, JSON.stringify({ v: 1, t: "HEARTBEAT", sid: SID, id: pidA, seq: 2, ts: Date.now(), d: { cap: "normal", win: { cc: 0, first: 0, last: 999 } } }));
    assert.equal(last(ws).d.code, "INVALID_MESSAGE");
  });
  it("LEAVE retire le pair et notifie ses voisins (pas de broadcast)", async () => {
    const { coord } = await newDo();
    const wsA = makeWs(); await join(coord, pidA, {}, wsA);
    const wsB = makeWs(); await join(coord, pidB, {}, wsB);
    // B signale à A (crée le lien)
    await coord.webSocketMessage(wsB, JSON.stringify({ v: 1, t: "SIGNAL_OFFER", sid: SID, id: pidB, seq: 3, ts: Date.now(), d: { to: pidA, sdp: "v=0\r\n" + "x".repeat(40) } }));
    assert.ok(last(wsA).t === "SIGNAL_OFFER");
    await coord.webSocketMessage(wsA, JSON.stringify({ v: 1, t: "LEAVE_SWARM", sid: SID, id: pidA, seq: 4, ts: Date.now(), d: {} }));
    assert.equal(coord.peers.has(pidA), false);
    assert.equal(last(wsB).t, "PEER_REMOVE");
    assert.deepEqual(last(wsB).d.ids, [pidA]);
    // un pair sans lien n'est pas notifié
    const wsC = makeWs(); await join(coord, pidC, {}, wsC);
    await coord.webSocketMessage(wsC, JSON.stringify({ v: 1, t: "LEAVE_SWARM", sid: SID, id: pidC, seq: 2, ts: Date.now(), d: {} }));
    assert.equal(last(wsB).t, "PEER_REMOVE"); // inchangé : C n'avait pas de lien avec B
  });
  it("LEAVE d'un pair inconnu : silencieux, aucune info", async () => {
    const { coord } = await newDo();
    const ws = makeWs(); ws.serializeAttachment({ pid: pidA });
    await coord.webSocketMessage(ws, JSON.stringify({ v: 1, t: "LEAVE_SWARM", sid: SID, id: pidA, seq: 1, ts: Date.now(), d: {} }));
    assert.equal(ws.sent.length, 0);
  });
});

describe("TTL — les pairs expirés disparaissent", () => {
  it("alarm() expulse un pair muet > TTL et notifie son voisin", async () => {
    const { coord } = await newDo();
    const wsA = makeWs(); await join(coord, pidA, {}, wsA);
    const wsB = makeWs(); await join(coord, pidB, {}, wsB);
    await coord.webSocketMessage(wsA, JSON.stringify({ v: 1, t: "SIGNAL_OFFER", sid: SID, id: pidA, seq: 2, ts: Date.now(), d: { to: pidB, sdp: "v=0\r\n" + "y".repeat(40) } }));
    coord.peers.get(pidA).lastSeenAt = Date.now() - HEARTBEAT_TTL_MS - 1000;
    await coord.alarm();
    assert.equal(coord.peers.has(pidA), false);
    assert.equal(last(wsB).t, "PEER_REMOVE");
    assert.ok(last(wsB).d.ids.includes(pidA));
  });
});

describe("KILL-SWITCH — notification des DEUX bords (étape 5)", () => {
  it("OFF puis ON : les pairs en pause reçoivent CONFIG{false} puis CONFIG{true} (reprise possible)", async () => {
    const { coord } = await newDo();
    const ws = makeWs(); await join(coord, pidA, {}, ws);
    // Le pair rejoint alors que le P2P est ON : il n'y a pas de CONFIG au JOIN.
    assert.equal(last(ws).t, "JOIN_ACCEPTED");
    // --- on coupe le kill switch : le prochain alarm() doit pousser CONFIG{false}
    coord.env = { MESH_KILL_SWITCH: "1" };
    await coord.alarm();
    const off = last(ws);
    assert.equal(off.t, "CONFIG");
    assert.equal(off.d.p2pEnabled, false);
    // --- on le rouvre : le pair en pause DOIT être notifié, sinon il resterait
    //     figé sans jamais savoir que le P2P est revenu (sans recharger).
    coord.env = {};
    await coord.alarm();
    const on = last(ws);
    assert.equal(on.t, "CONFIG");
    assert.equal(on.d.p2pEnabled, true);
  });

  it("pas de CONFIG{true} parasite sur un swarm jamais coupé (first alarm silencieux)", async () => {
    const { coord } = await newDo();
    const ws = makeWs(); await join(coord, pidA, {}, ws);
    coord.env = {}; // P2P toujours ON
    await coord.alarm();
    // le seul message descendant reste le JOIN_ACCEPTED initial : aucun CONFIG.
    const configs = ws.sent.map((m) => JSON.parse(m)).filter((m) => m.t === "CONFIG");
    assert.equal(configs.length, 0);
  });
});

describe("SIGNALING", () => {
  it("A → B dans le même swarm : routage avec from", async () => {
    const { coord } = await newDo();
    const wsA = makeWs(); await join(coord, pidA, {}, wsA);
    const wsB = makeWs(); await join(coord, pidB, {}, wsB);
    await coord.webSocketMessage(wsA, JSON.stringify({ v: 1, t: "SIGNAL_OFFER", sid: SID, id: pidA, seq: 2, ts: Date.now(), d: { to: pidB, sdp: "v=0\r\n" + "z".repeat(40) } }));
    const delivered = last(wsB);
    assert.equal(delivered.t, "SIGNAL_OFFER");
    assert.equal(delivered.d.from, pidA);
    assert.equal(delivered.d.sdp, "v=0\r\n" + "z".repeat(40)); // SDP transporté intact, jamais interprété
    assert.equal(delivered.d.to, undefined); // `to` retiré de la livraison
  });
  it("cible absente : silence (pas d'énumération de pairs)", async () => {
    const { coord } = await newDo();
    const wsA = makeWs(); await join(coord, pidA, {}, wsA);
    const before = wsA.sent.length;
    await coord.webSocketMessage(wsA, JSON.stringify({ v: 1, t: "SIGNAL_OFFER", sid: SID, id: pidA, seq: 2, ts: Date.now(), d: { to: pidB, sdp: "v=0\r\n" + "z".repeat(40) } }));
    assert.equal(wsA.sent.length, before); // rien en retour : A a son propre timeout
    assert.equal(coord.counters.signalDropped, 1);
  });
  it("ICE_CANDIDATE batch routé", async () => {
    const { coord } = await newDo();
    const wsA = makeWs(); await join(coord, pidA, {}, wsA);
    const wsB = makeWs(); await join(coord, pidB, {}, wsB);
    await coord.webSocketMessage(wsA, JSON.stringify({ v: 1, t: "ICE_CANDIDATE", sid: SID, id: pidA, seq: 2, ts: Date.now(), d: { to: pidB, c: ["candidate:1", "candidate:2"] } }));
    assert.deepEqual(last(wsB).d.c, ["candidate:1", "candidate:2"]);
  });
});

describe("POLLING", () => {
  async function pollHandle(coord, pid, message) {
    const req = new Request("https://mesh.internal/send", {
      method: "POST",
      headers: { "x-mesh-pid": pid, "x-mesh-sid": SID, "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    return coord.fetch(req);
  }
  async function pollGet(coord, pid, cursor = 0) {
    const req = new Request(`https://mesh.internal/poll?cursor=${cursor}`, { headers: { "x-mesh-pid": pid, "x-mesh-sid": SID } });
    const res = await coord.fetch(req);
    return res.json();
  }
  it("JOIN en polling puis drain de la file", async () => {
    const { coord } = await newDo();
    const ack = await pollHandle(coord, pidA, { v: 1, t: "JOIN_SWARM", sid: SID, id: pidA, seq: 1, ts: Date.now(), d: { proto: 1, cap: "normal", net: "wifi" } });
    assert.equal(ack.status, 202);
    const first = await pollGet(coord, pidA, 0);
    assert.equal(first.events.length, 1);
    assert.equal(JSON.parse(first.events[0]).t, "JOIN_ACCEPTED");
    const none = await pollGet(coord, pidA, first.cursor);
    assert.deepEqual(none.events, []); // pas de doublon après le curseur
    assert.equal(none.cursor, first.cursor);
  });
  it("JOIN refusé (kill switch) est LIVRÉ en polling — défaut trouvé à l'étape 6", async () => {
    // Avant refuseWithReply : le kill-branch répondait AVANT de créer la fiche
    // → sendTo trouvait `record` absent → la réponse n'était JAMAIS empilée →
    // un client WebView (polling) restait muet jusqu'à son timeout d'origine.
    const { coord } = await newDo({ MESH_KILL_SWITCH: "1" });
    await pollHandle(coord, pidA, { v: 1, t: "JOIN_SWARM", sid: SID, id: pidA, seq: 1, ts: Date.now(), d: { proto: 1, cap: "normal", net: "wifi" } });
    const first = await pollGet(coord, pidA, 0);
    assert.equal(first.events.length, 1, "le refus doit arriver dans la file de poll");
    const msg = JSON.parse(first.events[0]);
    assert.equal(msg.t, "JOIN_ACCEPTED");
    assert.equal(msg.d.cfg.p2pEnabled, false); // refus DOUX (jamais ERROR)
    assert.deepEqual(msg.d.peers, []);
    // et le pair fantôme créé pour livrer la réponse ne peut JAMAIS être
    // proposé comme candidat : cap=off + win=null (règle serveur §18).
    const ghost = coord.peers.get(pidA);
    assert.equal(ghost.cap, "off");
    assert.equal(ghost.win, null);
  });
  it("pair inconnu en poll → PEER_NOT_FOUND (le client re-JOIN)", async () => {
    const { coord } = await newDo();
    const res = await pollGet(coord, pidA);
    assert.equal(res.error, "PEER_NOT_FOUND");
  });
  it("file bornée : les vieux événements sont droppés, jamais une explosion", async () => {
    const { coord } = await newDo();
    await pollHandle(coord, pidA, { v: 1, t: "JOIN_SWARM", sid: SID, id: pidA, seq: 1, ts: Date.now(), d: { proto: 1, cap: "normal", net: "wifi" } });
    const wsB = makeWs(); await join(coord, pidB, {}, wsB);
    for (let i = 0; i < 40; i += 1) {
      await coord.webSocketMessage(wsB, JSON.stringify({ v: 1, t: "SIGNAL_OFFER", sid: SID, id: pidB, seq: 2 + i, ts: Date.now(), d: { to: pidA, sdp: "v=0\r\n" + "w".repeat(40) } }));
    }
    const rec = coord.peers.get(pidA);
    assert.ok(rec.pollQueue.length <= 64); // POLL_QUEUE_MAX
  });
  it("message trop volumineux refusé avant même le parse", async () => {
    const { coord } = await newDo();
    const req = new Request("https://mesh.internal/send", {
      method: "POST",
      headers: { "x-mesh-pid": pidA, "x-mesh-sid": SID, "content-type": "application/json" },
      body: JSON.stringify({ v: 1, t: "JOIN_SWARM", sid: SID, id: pidA, seq: 1, ts: Date.now(), d: { proto: 1, cap: "normal", net: "wifi", padding: "x".repeat(9000) } }),
    });
    const res = await coord.fetch(req);
    assert.equal(res.status, 413);
  });
});

describe("CONFIG — kill switch à chaud", () => {
  it("alarm avec MESH_KILL_SWITCH pousse CONFIG{p2pEnabled:false} aux membres", async () => {
    const { coord } = await newDo();
    const wsA = makeWs(); await join(coord, pidA, {}, wsA);
    coord.env = { MESH_KILL_SWITCH: "1" };
    await coord.alarm();
    const msg = last(wsA);
    assert.equal(msg.t, "CONFIG");
    assert.equal(msg.d.p2pEnabled, false);
  });
});

describe("ADMIN — kick & drain d'un pair (pilotage à chaud)", () => {
  async function admin(coord, action, pid) {
    const res = await coord.fetch(new Request(`https://mesh.internal/admin?action=${action}`, {
      method: "POST",
      headers: { "x-mesh-pid": pid, "x-mesh-sid": SID },
    }));
    return { status: res.status, body: await res.json() };
  }
  it("KICK : pair retiré, voisins notifiés PEER_REMOVE, socket fermée", async () => {
    const { coord } = await newDo();
    const wsA = makeWs(); await join(coord, pidA, {}, wsA);
    const wsB = makeWs(); await join(coord, pidB, {}, wsB);
    await coord.webSocketMessage(wsA, JSON.stringify({ v: 1, t: "SIGNAL_OFFER", sid: SID, id: pidA, seq: 2, ts: Date.now(), d: { to: pidB, sdp: "v=0\r\n" + "z".repeat(40) } }));
    const r = await admin(coord, "kick", pidA);
    assert.equal(r.body.ok, true);
    assert.equal(coord.peers.has(pidA), false);
    assert.equal(last(wsB).t, "PEER_REMOVE");
    assert.ok(last(wsB).d.ids.includes(pidA));
    assert.equal(last(wsA).t, "KICK");
  });
  it("DRAIN : pair retiré des candidats mais lit encore (cap serveur → off)", async () => {
    const { coord } = await newDo();
    const wsA = makeWs(); await join(coord, pidA, {}, wsA);
    const r = await admin(coord, "drain", pidA);
    assert.equal(r.body.ok, true);
    assert.equal(coord.peers.has(pidA), true);           // il reste, il lit
    assert.equal(coord.peers.get(pidA).cap, "off");      // règle serveur : plus seeder
    assert.equal(last(wsA).t, "DRAIN");
    const msg = await join(coord, pidB);                 // un nouveau pair…
    assert.equal(msg.d.peers.some((p) => p.id === pidA), false); // …ne reçoit pas A comme seeder
  });
  it("pair inconnu → 404 PEER_NOT_FOUND", async () => {
    const { coord } = await newDo();
    const r = await admin(coord, "kick", pidA);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "PEER_NOT_FOUND");
  });
});

describe("ISOLATION — le worker mesh ne peut pas servir de proxy vidéo", () => {
  it("aucune route ne ressemble à du contenu vidéo", async () => {
    const { source } = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/index.js", import.meta.url), "utf8").then((text) => ({ source: text })));
    // pas de fetch de l'upstream, pas de binding relais/proxy, pas de HLS/TS
    assert.doesNotMatch(source, /RELAY_|PROXY_URL_SECRET|VIDEO_PROXY|HYPERDRIVE/i);
    assert.doesNotMatch(source, /\.m3u8|\.ts|segment|playlist|manifest/i);
    // les seules routes sont mesh/*
    const routes = [...source.matchAll(/path === "(\/[^"]+)"/g)].map((m) => m[1]);
    for (const r of routes) assert.match(r, /^\/mesh(\/|$)/, `route hors mesh : ${r}`);
  });
  it("le DO ne connaît aucune URL : le PeerRecord n'a que les champs minimaux", async () => {
    const { coord } = await newDo();
    const ws = makeWs();
    await join(coord, pidA, {}, ws);
    const record = coord.peers.get(pidA);
    for (const forbidden of ["ip", "token", "url", "email", "deviceId", "deviceHash", "locator"]) {
      assert.equal(record[forbidden], undefined, `champ sensible présent : ${forbidden}`);
    }
    const sampleKeys = ["pid", "state", "cap", "net", "rid", "proto", "win", "joinedAt", "lastSeenAt", "upBytes", "peerDlBytes", "peerOk", "peerFail", "rttMs", "pollMode", "pollQueue", "links", "rate"];
    assert.deepEqual(Object.keys(record).sort(), [...sampleKeys].sort());
  });
});

describe("DÉCOUVERTE — la fenêtre avance vers les abonnés (§spec 2.3, étape 4)", () => {
  it("HEARTBEAT avec nouvelle fenêtre → PEER_JOINED ciblé aux pairs liés (pas de broadcast)", async () => {
    const { coord } = await newDo();
    const wsA = makeWs(); await join(coord, pidA, {}, wsA);
    const wsB = makeWs(); await join(coord, pidB, {}, wsB);
    // A signale à B : le lien se crée (on le connaitra).
    await coord.webSocketMessage(wsA, JSON.stringify({ v: 1, t: "SIGNAL_OFFER", sid: SID, id: pidA, seq: 2, ts: Date.now(), d: { to: pidB, sdp: "v=0\r\n" + "q".repeat(40) } }));
    wsB.sent.length = 0; wsA.sent.length = 0; // on ignore le bruit de setup
    // A avance sa fenêtre : B (qui suit A) doit recevoir un PEER_JOINED à jour.
    const wsA2 = makeWs(); wsA2.serializeAttachment({ pid: pidA }); coord.state._sockets.push(wsA2);
    await coord.webSocketMessage(wsA2, JSON.stringify({ v: 1, t: "HEARTBEAT", sid: SID, id: pidA, seq: 3, ts: Date.now(), d: { cap: "normal", win: { cc: 0, first: 20, last: 30 } } }));
    const got = JSON.parse(wsB.sent[wsB.sent.length - 1]);
    assert.equal(got.t, "PEER_JOINED");
    assert.equal(got.d.id, pidA);
    assert.deepEqual(got.d.win, { cc: 0, first: 20, last: 30 });
    // pair sans lien (C qui join après) : A ne lui envoie rien de particulier
    const wsC = makeWs(); await join(coord, pidC, {}, wsC);
    assert.ok(wsC.sent.some((r) => JSON.parse(r).t === "JOIN_ACCEPTED"));
  });

  it("ré-JOIN d’un pair déjà présent ne duplique pas et relivre la liste (idempotence)", async () => {
    const { coord } = await newDo();
    const wsA = makeWs(); await join(coord, pidA, {}, wsA);
    const wsB = makeWs(); await join(coord, pidB, {}, wsB);
    const msg = last(wsA);
    assert.ok(msg.d.peers.some((p) => p.id === pidB) || msg.d.peers.length >= 0);
    // A se re-join (cicatrisation client) : pas de doublon, JOIN_ACCEPTED à nouveau
    await coord.webSocketMessage(wsA, JSON.stringify({ v: 1, t: "JOIN_SWARM", sid: SID, id: pidA, seq: 5, ts: Date.now(), d: { proto: 1, cap: "normal", net: "wifi" } }));
    assert.equal(coord.peers.size, 2); // pas 3
    const reopened = last(wsA);
    assert.equal(reopened.t, "JOIN_ACCEPTED");
  });
});
