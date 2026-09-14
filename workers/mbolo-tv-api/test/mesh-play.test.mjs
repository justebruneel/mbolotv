// ============================================================================
// Non-régression du chemin /play avec MeshStream (ADR-0004, étape 3).
// Le Player actuel ne voit que url/expiresAt/qualityCap : ces tests figent
// que (a) sans le flag MESH_ENABLED la réponse est STRICTEMENT identique à
// l'existant (meshFieldsForPlay → {}), (b) avec le flag, les champs ajoutés
// parsent le contrat PlayResponse et le token vérifie la chaîne swarmId/peerId,
// (c) JAMAIS le mesh ne fait échouer un /play.
// Lancer : node --test 'workers/mbolo-tv-api/test/*.test.mjs'
// ============================================================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { meshFieldsForPlay } from "../src/mesh.js";
import { playResponseSchema, verifyMeshTokenSignature, meshPeerIdSchema } from "@mbolo/contracts";

// La vérification ici est la PRIMITIVE PARTAGÉE (verifyMeshTokenSignature de
// @mbolo/contracts) — la même que celle du worker mesh : un jeton émis par
// l'API se vérifie par la fonction que le mesh consommera. Les règles
// temporelles métier (auth.js) sont testées côté mesh (test/mesh.test.mjs).
const verifyMeshToken = (secret, token) => verifyMeshTokenSignature(secret, token);

const SECRET = "test-secret-mesh";
const ENV_OFF = {};
const ENV_ON = {
  MESH_ENABLED: "1",
  MESH_URL_SECRET: SECRET,
  MESH_PUBLIC_URL: "https://mbolo-tv-mesh.test.workers.dev",
  MESH_SOURCE_ALLOWLIST: "*",
};
const session = { channelId: "ch1", sourceId: "src1", variantId: "var1", eco: false };
const playExpiresAt = new Date(Date.now() + 3_600_000).toISOString();

describe("meshFieldsForPlay — drapeau et portes", () => {
  it("flag ABSENT → {} : la réponse /play reste BYTE-PER-BYTE l'existant", async () => {
    const fields = await meshFieldsForPlay(ENV_OFF, "device-1", session, playExpiresAt);
    assert.deepEqual(fields, {});
  });
  it("flag présent mais SECRET absent → {} aussi (jamais un token non signé)", async () => {
    assert.deepEqual(await meshFieldsForPlay({ MESH_ENABLED: "1", MESH_PUBLIC_URL: "https://x.dev" }, "d", session, playExpiresAt), {});
  });
  it("allowlist vide (défaut) → p2p:false explicite pour cette session", async () => {
    const fields = await meshFieldsForPlay({ ...ENV_ON, MESH_SOURCE_ALLOWLIST: "" }, "device-1", session, playExpiresAt);
    assert.deepEqual(fields, { p2p: false, meshToken: null, meshUrl: null, meshExpiresAt: null });
  });
  it("source hors allowlist → p2p:false ; source dans la liste → p2p:true", async () => {
    const off = await meshFieldsForPlay({ ...ENV_ON, MESH_SOURCE_ALLOWLIST: "src9,src8" }, "device-1", session, playExpiresAt);
    assert.equal(off.p2p, false);
    const on = await meshFieldsForPlay({ ...ENV_ON, MESH_SOURCE_ALLOWLIST: "src1,src8" }, "device-1", session, playExpiresAt);
    assert.equal(on.p2p, true);
  });
  it("deviceId absent → p2p:false (pas de DeviceGrant, pas de pair)", async () => {
    assert.equal((await meshFieldsForPlay(ENV_ON, undefined, session, playExpiresAt)).p2p, false);
  });
});

describe("meshFieldsForPlay — contenu du jeton", () => {
  it("les champs ajoutés parsent le contrat PlayResponse complet", async () => {
    const fields = await meshFieldsForPlay(ENV_ON, "device-1", session, playExpiresAt);
    const full = playResponseSchema.parse({ url: "https://proxy.test/?url=x&x-sig=y", expiresAt: playExpiresAt, qualityCap: 480, ...fields });
    assert.equal(full.p2p, true);
    assert.ok(meshPeerIdSchema.safeParse((await verifyMeshToken(SECRET, fields.meshToken)).payload.pid).success);
  });
  it("le meshUrl pointe vers /mesh/ws du worker mesh", async () => {
    const fields = await meshFieldsForPlay(ENV_ON, "device-1", session, playExpiresAt);
    assert.equal(fields.meshUrl, "https://mbolo-tv-mesh.test.workers.dev/mesh/ws");
  });
  it("swarmId déterministe : deux /play du même flux → même sid ; éco ≠ HD", async () => {
    const a = await meshFieldsForPlay(ENV_ON, "device-1", session, playExpiresAt);
    const b = await meshFieldsForPlay(ENV_ON, "device-2", session, playExpiresAt);
    const eco = await meshFieldsForPlay(ENV_ON, "device-1", { ...session, eco: true }, playExpiresAt);
    assert.equal((await verifyMeshToken(SECRET, a.meshToken)).payload.sid, (await verifyMeshToken(SECRET, b.meshToken)).payload.sid);
    assert.notEqual(a.meshToken, b.meshToken); // même swarm, pairs distincts
    assert.notEqual((await verifyMeshToken(SECRET, eco.meshToken)).payload.sid, (await verifyMeshToken(SECRET, a.meshToken)).payload.sid);
  });
  it("peerId : aléatoire cryptographique, deux /play du même appareil diffèrent", async () => {
    const a = await meshFieldsForPlay(ENV_ON, "device-1", session, playExpiresAt);
    const b = await meshFieldsForPlay(ENV_ON, "device-1", session, playExpiresAt);
    assert.notEqual(a.meshToken, b.meshToken);
  });
  it("TTL : calé sur expiresAt du play, plafonné 6 h", async () => {
    const fields = await meshFieldsForPlay(ENV_ON, "device-1", session, playExpiresAt);
    const { payload } = await verifyMeshToken(SECRET, fields.meshToken);
    assert.ok(payload.exp - payload.iat <= 6 * 3_600_000 + 1000);
    assert.equal(fields.meshExpiresAt, payload.exp);
  });
});

describe("meshFieldsForPlay — jamais une erreur de lecture", () => {
  it("session incomplète → OFF propre, pas d'exception", async () => {
    const off = await meshFieldsForPlay(ENV_ON, "d", { channelId: null, sourceId: null, variantId: null, eco: false }, playExpiresAt);
    assert.deepEqual(off, { p2p: false, meshToken: null, meshUrl: null, meshExpiresAt: null });
  });
  it("playExpiresAt invalide → OFF (le Date NaN est rattrapé), jamais un throw", async () => {
    const off = await meshFieldsForPlay(ENV_ON, "d", session, "pas-une-date");
    assert.equal(off.p2p, false);
  });
});
