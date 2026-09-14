// ============================================================================
// Tests des contrats MeshStream v1 (ADR-0004, étape 2).
// Valident les SCHÉMAS Zod uniquement — aucun serveur, aucun Cloudflare,
// aucun streaming impliqué. Le P2P reste inactif : ces contrats ne sont
// consommés par aucun code de production à ce stade.
// Lancer : node --test 'workers/mbolo-tv-api/test/*.test.mjs'
// ============================================================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MESH_PROTOCOL_VERSION,
  MESH_MAX_WINDOW_SEGMENTS,
  MESH_MAX_CANDIDATES,
  MESH_HARD_MAX_PEERS,
  meshClientMessageSchema,
  meshCoordinatorMessageSchema,
  meshP2pMessageSchema,
  meshTokenPayloadSchema,
  meshSegmentWindowSchema,
  meshConfigSchema,
  playResponseSchema,
  meshSwarmIdSchema,
  meshPeerIdSchema,
} from "@mbolo/contracts";

const SID = "a".repeat(32);            // swarmId factice : 32 hex
const PID = "abcdefghijklmnopqrstuv";  // peerId factice : 22 chars base64url
const PID2 = "vutsrqponmlkjihgfedcba";
const env = (t, d) => ({ v: MESH_PROTOCOL_VERSION, t, sid: SID, id: PID, seq: 1, ts: 1757000000000, d });

describe("mesh — enveloppe de signaling", () => {
  it("JOIN_SWARM valide accepté", () => {
    const r = meshClientMessageSchema.safeParse(env("JOIN_SWARM", { proto: 1, cap: "normal", net: "wifi", rid: null }));
    assert.equal(r.success, true);
  });
  it("version inconnue rejetée", () => {
    const bad = { ...env("JOIN_SWARM", { proto: 1, cap: "off", net: "wifi" }), v: 99 };
    assert.equal(meshClientMessageSchema.safeParse(bad).success, false);
  });
  it("champ obligatoire absent (cap) rejeté", () => {
    const r = meshClientMessageSchema.safeParse(env("JOIN_SWARM", { proto: 1, net: "wifi" }));
    assert.equal(r.success, false);
  });
  it("mauvais type (proto string) rejeté", () => {
    const r = meshClientMessageSchema.safeParse(env("JOIN_SWARM", { proto: "1", cap: "off", net: "wifi" }));
    assert.equal(r.success, false);
  });
  it("swarmId invalide rejeté", () => {
    assert.equal(meshSwarmIdSchema.safeParse("ZZ32").success, false);
    assert.equal(meshSwarmIdSchema.safeParse("a".repeat(64)).success, false); // trop long : le swarmId est tronqué à 128 bits
    const r = meshClientMessageSchema.safeParse({ ...env("HEARTBEAT", {}), sid: "x!" });
    assert.equal(r.success, false);
  });
  it("peerId invalide rejeté, format base64url 22 accepté", () => {
    assert.equal(meshPeerIdSchema.safeParse("court").success, false);
    assert.equal(meshPeerIdSchema.safeParse("a".repeat(23)).success, false);   // mauvaise longueur
    assert.equal(meshPeerIdSchema.safeParse("a".repeat(21) + "!").success, false); // caractère hors alphabet
    assert.equal(meshPeerIdSchema.safeParse(PID).success, true);
  });
  it("timestamp invalide (négatif/chaîne) rejeté", () => {
    assert.equal(meshClientMessageSchema.safeParse({ ...env("LEAVE_SWARM", {}), ts: -5 }).success, false);
    assert.equal(meshClientMessageSchema.safeParse({ ...env("LEAVE_SWARM", {}), ts: "1757000000000" }).success, false);
  });
  it("seq invalide (flottant, débordement) rejeté", () => {
    assert.equal(meshClientMessageSchema.safeParse({ ...env("LEAVE_SWARM", {}), seq: 1.5 }).success, false);
    assert.equal(meshClientMessageSchema.safeParse({ ...env("LEAVE_SWARM", {}), seq: 0x1_0000_0000 }).success, false);
  });
  it("payload inattendu rejeté (.strict())", () => {
    const r = meshClientMessageSchema.safeParse(env("LEAVE_SWARM", { extra: "injection" }));
    assert.equal(r.success, false);
  });
  it("type de message inconnu rejeté par la discriminated union", () => {
    assert.equal(meshClientMessageSchema.safeParse(env("EAT_THE_WORLD", {})).success, false);
  });
});

describe("mesh — messages client -> coordinateur", () => {
  it("HEARTBEAT accepte une fenêtre nulle (rien de seedable)", () => {
    assert.equal(meshClientMessageSchema.safeParse(env("HEARTBEAT", { win: null, cap: "off" })).success, true);
  });
  it("HEARTBEAT accepte une fenêtre cohérente", () => {
    const r = meshClientMessageSchema.safeParse(env("HEARTBEAT", { win: { cc: 3, first: 100, last: 110 }, cap: "low" }));
    assert.equal(r.success, true);
  });
  it("HEARTBEAT rejette une fenêtre trop large", () => {
    const r = meshClientMessageSchema.safeParse(env("HEARTBEAT", { win: { cc: 0, first: 0, last: MESH_MAX_WINDOW_SEGMENTS + 5 }, cap: "low" }));
    assert.equal(r.success, false);
  });
  it("STATS_REPORT borne les compteurs", () => {
    assert.equal(meshClientMessageSchema.safeParse(env("STATS_REPORT", { upBytes: -1, peerDlBytes: 0, peerOk: 0, peerFail: 0 })).success, false);
    assert.equal(meshClientMessageSchema.safeParse(env("STATS_REPORT", { upBytes: 0, peerDlBytes: 0, peerOk: 0, peerFail: 0 })).success, true);
  });
  it("FALLBACK_PING n'accepte que les raisons connues", () => {
    assert.equal(meshClientMessageSchema.safeParse(env("FALLBACK_PING", { sn: 42, reason: "PEER_TIMEOUT" })).success, true);
    assert.equal(meshClientMessageSchema.safeParse(env("FALLBACK_PING", { sn: 42, reason: "because_i_said_so" })).success, false);
  });
  it("SIGNAL_OFFER refuse un SDP énorme", () => {
    const r = meshClientMessageSchema.safeParse(env("SIGNAL_OFFER", { to: PID2, sdp: "x".repeat(16385) }));
    assert.equal(r.success, false);
  });
  it("ICE_CANDIDATE borne le batch (tempête de candidats impossible)", () => {
    assert.equal(meshClientMessageSchema.safeParse(env("ICE_CANDIDATE", { to: PID2, c: ["candidate:1 1 2 3"] })).success, true);
    const flood = Array.from({ length: 33 }, (_, i) => `candidate:${i}`);
    assert.equal(meshClientMessageSchema.safeParse(env("ICE_CANDIDATE", { to: PID2, c: flood })).success, false);
    // chaîne de candidat individuelle trop longue = message gonflé : rejeté
    assert.equal(meshClientMessageSchema.safeParse(env("ICE_CANDIDATE", { to: PID2, c: ["c".repeat(1025)] })).success, false);
  });
});

describe("mesh — messages coordinateur -> client", () => {
  it("JOIN_ACCEPTED accepte des candidats valides et refuse un excédent", () => {
    const cfg = {
      p2pEnabled: true, maxPeers: 4, peerTimeoutMs: 1500, bufferCriticalSec: 12,
      liveEdgeSafetySegments: 2, heartbeatMs: 30000, statsIntervalMs: 120000,
      pollIntervalMs: 4000, candidateSample: 8, windowSize: 20, chunkBytes: 65536,
      protocolVersion: 1, minProtocolVersion: 1,
    };
    assert.equal(meshCoordinatorMessageSchema.safeParse(env("JOIN_ACCEPTED", { peers: [{ id: PID, cap: "normal", proto: 1 }], cfg })).success, true);
    const trop = Array.from({ length: MESH_MAX_CANDIDATES + 1 }, () => ({ id: PID, cap: "off" }));
    assert.equal(meshCoordinatorMessageSchema.safeParse(env("JOIN_ACCEPTED", { peers: trop, cfg })).success, false);
  });
  it("JOIN_ACCEPTED refuse un maxPeers supérieur au plafond dur", () => {
    const cfgBad = {
      p2pEnabled: true, maxPeers: MESH_HARD_MAX_PEERS + 1, peerTimeoutMs: 1500, bufferCriticalSec: 12,
      liveEdgeSafetySegments: 2, heartbeatMs: 30000, statsIntervalMs: 120000,
      pollIntervalMs: 4000, candidateSample: 8, windowSize: 20, chunkBytes: 65536,
      protocolVersion: 1, minProtocolVersion: 1,
    };
    assert.equal(meshConfigSchema.safeParse(cfgBad).success, false);
  });
  it("ERROR n'accepte que les codes connus, sans message libre", () => {
    assert.equal(meshCoordinatorMessageSchema.safeParse(env("ERROR", { code: "INVALID_TOKEN" })).success, true);
    assert.equal(meshCoordinatorMessageSchema.safeParse(env("ERROR", { code: "OOPS" })).success, false);
    assert.equal(meshCoordinatorMessageSchema.safeParse(env("ERROR", { code: "RATE_LIMITED", retryAfterMs: 5000, message: "détail interne" })).success, false); // .strict : pas de fuite
  });
  it("SIGNAL_OFFER livré remplace to par from (le pair ne choisit pas sa cible)", () => {
    assert.equal(meshCoordinatorMessageSchema.safeParse(env("SIGNAL_OFFER", { from: PID2, sdp: "v=0\r\n" + "x".repeat(30) })).success, true);
    assert.equal(meshCoordinatorMessageSchema.safeParse(env("SIGNAL_OFFER", { to: PID2, sdp: "v=0\r\n" + "x".repeat(30) })).success, false);
  });
});

describe("mesh — protocole peer-to-peer (DataChannel)", () => {
  it("SEGMENT_REQUEST exige un nonce bien formé", () => {
    assert.equal(meshP2pMessageSchema.safeParse({ v: 1, t: "SEGMENT_REQUEST", seq: 7, d: { n: "abcdefghijklmnoP", cc: 0, sn: 1234 } }).success, true);
    assert.equal(meshP2pMessageSchema.safeParse({ v: 1, t: "SEGMENT_REQUEST", seq: 7, d: { n: "court", cc: 0, sn: 1234 } }).success, false);
  });
  it("SEGMENT_HEADER borne len et chunks", () => {
    assert.equal(meshP2pMessageSchema.safeParse({ v: 1, t: "SEGMENT_HEADER", seq: 1, d: { n: "abcdefghijklmnoP", cc: 0, sn: 9, len: 500000, chunks: 8 } }).success, true);
    assert.equal(meshP2pMessageSchema.safeParse({ v: 1, t: "SEGMENT_HEADER", seq: 1, d: { n: "abcdefghijklmnoP", cc: 0, sn: 9, len: 268435457, chunks: 8 } }).success, false);
    assert.equal(meshP2pMessageSchema.safeParse({ v: 1, t: "SEGMENT_HEADER", seq: 1, d: { n: "abcdefghijklmnoP", cc: 0, sn: 9, len: 500, chunks: 999999 } }).success, false);
  });
  it("SEGMENT_COMPLETE exige un sha256 hex canonique", () => {
    assert.equal(meshP2pMessageSchema.safeParse({ v: 1, t: "SEGMENT_COMPLETE", seq: 2, d: { n: "abcdefghijklmnoP", sha256: "f".repeat(64) } }).success, true);
    assert.equal(meshP2pMessageSchema.safeParse({ v: 1, t: "SEGMENT_COMPLETE", seq: 2, d: { n: "abcdefghijklmnoP", sha256: "pas-un-hash" } }).success, false);
  });
  it("pas de message coordinateur sur le canal peer (séparation stricte)", () => {
    // HEARTBEAT existe côté signaling, PAS côté DataChannel : un pair qui
    // l'enverrait est une anomalie -> rejet (jamais routé aveuglément).
    assert.equal(meshP2pMessageSchema.safeParse({ v: 1, t: "HEARTBEAT", seq: 0, d: {} }).success, false);
  });
});

describe("mesh — MeshToken (structure logique)", () => {
  it("payload minimal valide", () => {
    const r = meshTokenPayloadSchema.safeParse({ v: 1, pid: PID, sid: SID, did: "b".repeat(32), iat: 1757000000000, exp: 1757003600000 });
    assert.equal(r.success, true);
  });
  it("le schéma ne compare pas iat/exp — la cohérence est vérifiée au moment du signe/validate serveur (figé ici)", () => {
    assert.equal(meshTokenPayloadSchema.safeParse({ v: 1, pid: PID, sid: SID, did: "b".repeat(32), iat: 5, exp: 4 }).success, true); // accepté par le schéma : garde à implémenter côté worker mesh
  });
  it("aucun champ de données personnelles admissible (strict)", () => {
    assert.equal(meshTokenPayloadSchema.safeParse({ v: 1, pid: PID, sid: SID, did: "b".repeat(32), iat: 1, exp: 2, ip: "1.2.3.4" }).success, false);
    assert.equal(meshTokenPayloadSchema.safeParse({ v: 1, pid: PID, sid: SID, did: "b".repeat(32), iat: 1, exp: 2, email: "x@y.z" }).success, false);
  });
});

describe("mesh — PlayResponse rétrocompatibilité", () => {
  it("la réponse ACTUELLE (sans champs mesh) reste valide", () => {
    const current = { url: "https://proxy.example/?url=x&x-sig=y", expiresAt: new Date().toISOString(), qualityCap: 480 };
    assert.equal(playResponseSchema.safeParse(current).success, true);
  });
  it("une réponse avec p2p=false / null est valide", () => {
    const r = playResponseSchema.safeParse({ url: "https://proxy.example/", expiresAt: "x", p2p: false, meshToken: null, meshUrl: null });
    assert.equal(r.success, true);
  });
  it("une réponse avec p2p=true et jetons est valide", () => {
    const r = playResponseSchema.safeParse({ url: "https://proxy.example/", expiresAt: "x", p2p: true, meshToken: "abc.def", meshUrl: "https://mesh.example/ws?token=abc.def" });
    assert.equal(r.success, true);
  });
});
