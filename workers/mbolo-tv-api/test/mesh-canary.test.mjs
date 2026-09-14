// ============================================================================
// Canary MeshStream (étape 6) — allowlist par testeur (MESH_TESTER_ALLOWLIST).
// Porte ADDITIVE dans workers/mbolo-tv-api/src/mesh.js : sans la variable, le
// comportement est inchangé ; avec une liste, seuls les testeurs reçoivent un
// jeton. Le refus P2P ne casse JAMAIS /play (OFF propre, lecture intacte).
// Lancer : node --test workers/mbolo-tv-api/test/mesh-canary.test.mjs
// ============================================================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { meshFieldsForPlay, meshTesterAllowed } from "../src/mesh.js";
import { sha256Hex } from "../src/crypto.js";

const SECRET = "test-secret-canary";
const BASE = {
  MESH_ENABLED: "1",
  MESH_URL_SECRET: SECRET,
  MESH_PUBLIC_URL: "https://mbolo-tv-mesh.test.workers.dev",
  MESH_SOURCE_ALLOWLIST: "src1",
};
const session = { channelId: "ch1", sourceId: "src1", variantId: "var1", eco: true };
const playExpiresAt = new Date(Date.now() + 3_600_000).toISOString();

describe("meshTesterAllowed — porte canary", () => {
  it("variable absente → aucune restriction (compatibilité)", () => {
    assert.equal(meshTesterAllowed({}, "device-1"), true);
    assert.equal(meshTesterAllowed({ MESH_TESTER_ALLOWLIST: "" }, "device-1"), true);
    assert.equal(meshTesterAllowed({ MESH_TESTER_ALLOWLIST: "  " }, "device-1"), true);
  });
  it("'*' = ouvert explicite", () => {
    assert.equal(meshTesterAllowed({ MESH_TESTER_ALLOWLIST: "*" }, "n-importe-qui"), true);
  });
  it("deviceId brut listé → autorisé, sinon refusé", () => {
    const env = { MESH_TESTER_ALLOWLIST: "tester-a,tester-b" };
    assert.equal(meshTesterAllowed(env, "tester-a"), true);
    assert.equal(meshTesterAllowed(env, "tester-b"), true);
    assert.equal(meshTesterAllowed(env, "intrus"), false);
    assert.equal(meshTesterAllowed(env, undefined), false);
  });
  it("sha256(deviceId) listé → autorisé sans stocker l'identifiant brut", async () => {
    const hash = await sha256Hex("tester-hash");
    const hashAutre = await sha256Hex("autre");
    assert.equal(hash.length, 64);
    const env = { MESH_TESTER_ALLOWLIST: hash };
    assert.equal(meshTesterAllowed(env, "tester-hash", hash), true);
    assert.equal(meshTesterAllowed(env, "autre", hashAutre), false);
    // casse indifférente sur le hash
    assert.equal(meshTesterAllowed(env, "tester-hash", hash.toUpperCase()), true);
  });
  it("ne jette jamais (doute = refus, pas d'erreur)", () => {
    assert.equal(meshTesterAllowed(null, "x"), true);
    assert.equal(meshTesterAllowed({ MESH_TESTER_ALLOWLIST: "a" }, null), false);
  });
});

describe("meshFieldsForPlay — canary de bout en bout", () => {
  it("sans allowlist testeur : comportement inchangé (jeton émis)", async () => {
    const fields = await meshFieldsForPlay(BASE, "device-1", session, playExpiresAt);
    assert.equal(fields.p2p, true);
    assert.ok(typeof fields.meshToken === "string");
  });
  it("avec allowlist : testeur inscrit → p2p:true, intrus → p2p:false", async () => {
    const env = { ...BASE, MESH_TESTER_ALLOWLIST: "tester-a,tester-b" };
    const ok = await meshFieldsForPlay(env, "tester-a", session, playExpiresAt);
    assert.equal(ok.p2p, true);
    const ko = await meshFieldsForPlay(env, "intrus", session, playExpiresAt);
    assert.deepEqual(ko, { p2p: false, meshToken: null, meshUrl: null, meshExpiresAt: null });
  });
  it("avec allowlist par hash : seul le hash correspondant passe", async () => {
    const hash = await sha256Hex("tester-h");
    const env = { ...BASE, MESH_TESTER_ALLOWLIST: hash };
    assert.equal((await meshFieldsForPlay(env, "tester-h", session, playExpiresAt)).p2p, true);
    assert.equal((await meshFieldsForPlay(env, "autre", session, playExpiresAt)).p2p, false);
  });
  it("le refus canary ne change rien à la réponse classique (pas de throw)", async () => {
    const env = { ...BASE, MESH_TESTER_ALLOWLIST: "seulement-moi" };
    const off = await meshFieldsForPlay(env, "pas-moi", session, playExpiresAt);
    assert.equal(off.p2p, false);
    assert.equal(off.meshToken, null);
  });
  it("source hors allowlist + testeur inscrit → toujours p2p:false (les deux portes comptent)", async () => {
    const env = { ...BASE, MESH_SOURCE_ALLOWLIST: "autre-source", MESH_TESTER_ALLOWLIST: "tester-a" };
    assert.equal((await meshFieldsForPlay(env, "tester-a", session, playExpiresAt)).p2p, false);
  });
});
