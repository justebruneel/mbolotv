// Tests unitaires des en-têtes CORS du Worker API (corsHeaders).
// Lancer : node --test 'workers/mbolo-tv-api/test/*.test.mjs'
// Point crucial : une origine absente de CORS_ALLOWED_ORIGINS ne doit JAMAIS
// recevoir d'access-control-allow-origin — ni par réflexion, ni par "*".
// Liste vide = configuration refusée (pas de réflexion libre).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { corsHeaders } from "../src/index.js";

function requestWithOrigin(origin) {
  return { headers: { get: (name) => (name.toLowerCase() === "origin" ? origin : null) }, method: "GET" };
}

describe("corsHeaders — allowlist", () => {
  const env = { CORS_ALLOWED_ORIGINS: "https://mbolotv-web.vercel.app,https://mbolo.tv" };

  it("autorise une origine de la liste", () => {
    const headers = corsHeaders(requestWithOrigin("https://mbolo.tv"), env);
    assert.equal(headers["access-control-allow-origin"], "https://mbolo.tv");
  });

  it("refuse une origine inconnue (aucun en-tête ACAO)", () => {
    const headers = corsHeaders(requestWithOrigin("https://evil.example.com"), env);
    assert.ok(!("access-control-allow-origin" in headers));
  });

  it("refuse localhost même si d'autres origines sont autorisées", () => {
    const headers = corsHeaders(requestWithOrigin("http://localhost:3000"), env);
    assert.ok(!("access-control-allow-origin" in headers));
  });

  it("liste vide : refuse toute origine (pas de réflexion libre)", () => {
    for (const allowedEnv of [{}, { CORS_ALLOWED_ORIGINS: "" }]) {
      const headers = corsHeaders(requestWithOrigin("https://nimportequoi.dev"), allowedEnv);
      assert.ok(!("access-control-allow-origin" in headers));
    }
  });

  it("requête sans en-tête Origin (same-origin, curl) : pas d'ACAO mais réponses utilisables", () => {
    const headers = corsHeaders(requestWithOrigin(null), env);
    assert.ok(!("access-control-allow-origin" in headers));
    assert.equal(headers.vary, "Origin");
  });

  it("normalise les espaces autour des origines", () => {
    const headers = corsHeaders(requestWithOrigin("https://mbolotv-web.vercel.app"), {
      CORS_ALLOWED_ORIGINS: " https://mbolotv-web.vercel.app , https://mbolo.tv ",
    });
    assert.equal(headers["access-control-allow-origin"], "https://mbolotv-web.vercel.app");
  });
});
