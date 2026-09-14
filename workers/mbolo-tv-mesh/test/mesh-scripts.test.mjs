// ============================================================================
// Tests des scripts canary (ADR-0004, étape 6) — SANS appareils réels :
// mesh-capture.mjs (validation, provenance, fuites, runId) et mesh-report.mjs
// (métriques nommées, protection real-device, décisions) sont exercés en
// processus enfant sur des dumps SYNTHÉTIQUES (provenance mock ou real-device
// synthétique en tmp — jamais une preuve réelle).
// Lancer : node --test workers/mbolo-tv-mesh/test/mesh-scripts.test.mjs
// ============================================================================
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CAPTURE = join(ROOT, "scripts", "mesh-capture.mjs");
const REPORT = join(ROOT, "scripts", "mesh-report.mjs");
const EXAMPLE_RUN = join(ROOT, "mesh-test-runs", "run-example-a-b-mock.json");

let TMP = null;
const run = (script, args) => execFileSync("node", [script, ...args], { encoding: "utf8" });

function dump(overrides = {}, events = []) {
  return {
    v: 1, provenance: "mock", deviceClass: "desktop",
    startedAt: "2026-09-14T10:00:00.000Z", swarm: "ab12cd34",
    peer: "peerAAAAAAAAAAAAAAAAAA", meshAttempts: 0, memoryHits: 0,
    persistentCacheHits: 0, peerHits: 0, originHits: 1, peerFailures: 0,
    peerTimeouts: 0, peerHashFailures: 0, webrtcSuccess: 0, webrtcFailure: 0,
    bytesFromPeers: 0, bytesFromOrigin: 100, bytesFromMemory: 0,
    bytesFromIndexedDB: 0, bytesServedToPeers: 0, peers: 0,
    peerHitRate: 0, meshOffload: 0, dropped: 0, events,
    ...overrides,
  };
}
const T = (t, kw = {}) => ({ t, ...kw });

before(() => { TMP = mkdtempSync(join(tmpdir(), "mesh-scripts-")); });

describe("mesh-capture — validation et garde-fous", () => {
  it("forme courte : args positionnels + défauts run/out", () => {
    const f = join(TMP, "dev-a.json");
    writeFileSync(f, JSON.stringify(dump({}, [T("tier", { cc: 0, sn: 1, tier: "origin", ms: 10, at: 1000, rel: 0 })])));
    const out = run(CAPTURE, [f, "--out", join(TMP, "short.json")]);
    assert.match(out, /session\(s\), 1 événement/);
    const normalized = JSON.parse(readFileSync(join(TMP, "short.json"), "utf8"));
    assert.ok(/^run-\d{8}-\d{4}$/.test(normalized.runId));
    assert.equal(normalized.sessionCount, 1);
  });
  it("runId annoté adopté quand --run absent ; désaccord = avertissement, pas d'échec", () => {
    const f = join(TMP, "dev-run.json");
    writeFileSync(f, JSON.stringify(dump({ runId: "run-tmp-annotated" }, [])));
    const normalized = JSON.parse((() => {
      run(CAPTURE, [f, "--out", join(TMP, "annotated.json")]);
      return readFileSync(join(TMP, "annotated.json"), "utf8");
    })());
    assert.equal(normalized.runId, "run-tmp-annotated");
  });
  it("runIds contradictoires sans --run = échec (mélange de sessions ?)", () => {
    const f1 = join(TMP, "dev-r1.json"), f2 = join(TMP, "dev-r2.json");
    writeFileSync(f1, JSON.stringify(dump({ runId: "run-aaa" }, [])));
    writeFileSync(f2, JSON.stringify(dump({ runId: "run-bbb" }, [])));
    assert.throws(() => run(CAPTURE, [f1, f2, "--out", join(TMP, "nope.json")]), /contradictoires/);
  });
  it("fuite (URL/token) = rejet, jamais nettoyé", () => {
    const f = join(TMP, "dev-leak.json");
    writeFileSync(f, JSON.stringify(dump({}, [T("tier", { cc: 0, sn: 1, tier: "peer", ms: 1, url: "https://evil/seg.ts" })])));
    assert.throws(() => run(CAPTURE, [f, "--run", "run-leak", "--check-only"]), /DONNÉE INTERDITE/);
  });
  it("promotion mock → real-device INTERDITE", () => {
    const f = join(TMP, "dev-mock.json");
    writeFileSync(f, JSON.stringify(dump({ provenance: "mock" }, [])));
    assert.throws(() => run(CAPTURE, [f, "--run", "run-promo", "--provenance", "real-device", "--check-only"]), /promotion/);
  });
  it("timestamps manquants normalisés (rel complété, pas de crash)", () => {
    const f = join(TMP, "dev-norel.json");
    writeFileSync(f, JSON.stringify(dump({}, [T("tier", { cc: 0, sn: 1, tier: "origin", ms: 5, at: 2000 }), T("tier", { cc: 0, sn: 2, tier: "origin", ms: 5, at: 6000 })])));
    run(CAPTURE, [f, "--run", "run-norel", "--out", join(TMP, "norel.json")]);
    const normalized = JSON.parse(readFileSync(join(TMP, "norel.json"), "utf8"));
    const rels = normalized.events.map((e) => e.rel);
    assert.deepEqual(rels, [0, 4000]);
    assert.equal(normalized.sessions[0].normalizedTimestamps, 2);
  });
});

describe("mesh-report — métriques, protection, décisions", () => {
  it("exemple mock : métriques nommées présentes, pas de validation", () => {
    assert.ok(existsSync(EXAMPLE_RUN), "exemple run-example-a-b-mock.json attendu");
    const report = JSON.parse(run(REPORT, [EXAMPLE_RUN, "--json"]));
    for (const k of ["REAL_P2P_VIDEO", "ICE_SUCCESS_RATE", "DATACHANNEL_SUCCESS_RATE", "PEER_SEGMENT_RATIO", "PEER_BYTE_RATIO", "ORIGIN_SEGMENT_RATIO", "ORIGIN_BYTE_RATIO", "CACHE_RATIO", "FALLBACK_RATE", "HASH_FAILURE_RATE", "TIMEOUT_RATE", "STALL_RATE", "RESILIENCE_A_B_C", "TURN_DECISION", "DECISION_CANARY"]) {
      assert.ok(k in report.metrics, `métrique manquante: ${k}`);
    }
    assert.equal(report.metrics.REAL_P2P_VIDEO, "NOT_VALIDATED");
    assert.equal(report.metrics.TURN_DECISION, "INSUFFICIENT_DATA");
    assert.equal(report.sessions.mock, 2);
    assert.equal(report.sessions.realDevice, 0);
  });
  it("run-id sans extension résolu (mesh-test-runs/<run-id>)", () => {
    const report = JSON.parse(run(REPORT, ["mesh-test-runs/run-example-a-b-mock", "--json"]));
    assert.equal(report.metrics.REAL_P2P_VIDEO, "NOT_VALIDATED");
  });
  it("preuve complète synthétique real-device → VALIDATED (même tid/swarm, DC bilatéral)", () => {
    const fa = join(TMP, "sdev-a.json"), fb = join(TMP, "sdev-b.json");
    const base = { provenance: "real-device", runId: "run-tmp-valid", peerHits: 1, originHits: 1, bytesFromPeers: 500, bytesFromOrigin: 500 };
    writeFileSync(fa, JSON.stringify(dump({ ...base, peer: "peerAAAAAAAAAAAAAAAAAA" }, [
      T("iceResult", { pid: "peerBBBBBBBBBBBBBBBBBB", ok: true, ms: 300, reason: "connected", at: 1800, rel: 800 }),
      T("dc", { pid: "peerBBBBBBBBBBBBBBBBBB", state: "open", at: 1900, rel: 900 }),
      T("transfer", { tid: "TidShared00000001", pid: "peerBBBBBBBBBBBBBBBBBB", role: "srv", cc: 0, sn: 42, ok: true, bytes: 500, ms: 120, at: 5000, rel: 4000 }),
    ])));
    writeFileSync(fb, JSON.stringify(dump({ ...base, peer: "peerBBBBBBBBBBBBBBBBBB" }, [
      T("iceResult", { pid: "peerAAAAAAAAAAAAAAAAAA", ok: true, ms: 310, reason: "connected", at: 1900, rel: 800 }),
      T("dc", { pid: "peerAAAAAAAAAAAAAAAAAA", state: "open", at: 2000, rel: 900 }),
      T("transfer", { tid: "TidShared00000001", pid: "peerAAAAAAAAAAAAAAAAAA", role: "req", cc: 0, sn: 42, ok: true, bytes: 500, ms: 210, at: 5200, rel: 4100 }),
      T("tier", { cc: 0, sn: 42, tier: "peer", ms: 215, at: 5210, rel: 4110 }),
    ])));
    run(CAPTURE, [fa, fb, "--run", "run-tmp-valid", "--out", join(TMP, "run-tmp-valid.json")]);
    const report = JSON.parse(run(REPORT, [join(TMP, "run-tmp-valid.json"), "--json"]));
    assert.equal(report.metrics.REAL_P2P_VIDEO, "VALIDATED");
    assert.equal(report.metrics.ICE_SUCCESS_RATE, 1);
    assert.equal(report.metrics.DATACHANNEL_SUCCESS_RATE, 1);
  });
  it("même tid mais swarm divergent → NOT_VALIDATED (near-miss explicite)", () => {
    const fa = join(TMP, "sdev-c.json"), fb = join(TMP, "sdev-d.json");
    const base = { provenance: "real-device", runId: "run-tmp-swarm" };
    writeFileSync(fa, JSON.stringify(dump({ ...base, swarm: "ab12cd34", peer: "peerAAAAAAAAAAAAAAAAAA" }, [
      T("dc", { pid: "peerBBBBBBBBBBBBBBBBBB", state: "open", at: 1900, rel: 900 }),
      T("transfer", { tid: "TidShared00000002", pid: "peerBBBBBBBBBBBBBBBBBB", role: "srv", cc: 0, sn: 7, ok: true, bytes: 500, ms: 100, at: 5000, rel: 4000 }),
    ])));
    writeFileSync(fb, JSON.stringify(dump({ ...base, swarm: "ffffffff", peer: "peerBBBBBBBBBBBBBBBBBB" }, [
      T("dc", { pid: "peerAAAAAAAAAAAAAAAAAA", state: "open", at: 2000, rel: 900 }),
      T("transfer", { tid: "TidShared00000002", pid: "peerAAAAAAAAAAAAAAAAAA", role: "req", cc: 0, sn: 7, ok: true, bytes: 500, ms: 200, at: 5200, rel: 4100 }),
    ])));
    run(CAPTURE, [fa, fb, "--run", "run-tmp-swarm", "--out", join(TMP, "run-tmp-swarm.json")]);
    const report = JSON.parse(run(REPORT, [join(TMP, "run-tmp-swarm.json"), "--json"]));
    assert.equal(report.metrics.REAL_P2P_VIDEO, "NOT_VALIDATED");
    assert.match(JSON.stringify(report.p2p.nearMiss), /swarm/);
  });
  it("STOP si stall > 5 s (DECISION_CANARY=STOP avec signal explicite)", () => {
    const f = join(TMP, "sdev-stall.json");
    writeFileSync(f, JSON.stringify(dump({ provenance: "real-device", runId: "run-tmp-stall" }, [
      T("stall", { durMs: 6200, bufferSec: 0.4, at: 9000, rel: 8000 }),
    ])));
    run(CAPTURE, [f, "--run", "run-tmp-stall", "--out", join(TMP, "run-tmp-stall.json")]);
    const report = JSON.parse(run(REPORT, [join(TMP, "run-tmp-stall.json"), "--json"]));
    assert.equal(report.metrics.DECISION_CANARY, "STOP");
    assert.match(JSON.stringify(report.stopFlags), /stall/);
  });
});
