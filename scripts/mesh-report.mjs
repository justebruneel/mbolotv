#!/usr/bin/env node
// ============================================================================
// mesh-report.mjs — Rapport canary MeshStream à partir de runs normalisés.
//
// Usage :
//   node scripts/mesh-report.mjs ./mesh-test-runs/run-2026-09-14-a-b.json
//   node scripts/mesh-report.mjs ./mesh-test-runs/<run-id>   # extension .json optionnelle
//   node scripts/mesh-report.mjs ./mesh-test-runs/*.json [--json] [--out rapport.md]
//
// PROTECTION REAL-DEVICE (absolue) : seules les sessions provenance=real-device
// comptent. REAL_P2P_VIDEO = VALIDATED exige, pour au moins un `tid` :
//   requester ok + seeder ok + même tid + même (cc,sn) + même swarm +
//   octets > 0 + DataChannel réellement ouvert des DEUX côtés.
// Sinon : REAL_P2P_VIDEO = NOT_VALIDATED. Un mock ne peut jamais valider.
//
// TURN : INSUFFICIENT_DATA (< 10 tentatives ICE) · NO_TURN_NEEDED_YET
// (≥ 10 tentatives et succès ≥ 60 %) · TURN_RECOMMENDED (≥ 10 tentatives et
// succès < 60 %). Ne jamais décider TURN sur quelques observations isolées.
// ============================================================================
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIN_ICE_FOR_TURN = 10;
const TURN_SUCCESS_THRESHOLD = 0.6; // runbook : seuil utile ≈ 60-70 % sur données réelles
const STALL_STOP_MS = 5000;         // STOP CONDITION : stall > 5 s
const STALL_WARN_MS = 2000;         // signal d'alerte (pas de STOP)
const PLAY_ERROR_STOP = 5;          // STOP : erreurs de lecture nombreuses
const HASH_STOP = 3;                // STOP : corruptions répétées (pair menteur / bug)
const EXPAND_MAX_FALLBACK = 0.5;    // EXPAND seulement si repli < 50 % des paris

function fail(msg) { console.error(`mesh-report: ERREUR: ${msg}`); process.exit(1); }

const rawArgs = process.argv.slice(2);
const asJson = rawArgs.includes('--json');
const outArg = rawArgs.find((a) => a.startsWith('--out'));
const outPath = outArg ? resolve(outArg.split('=')[1] ?? outArg) : null;
const args = rawArgs.filter((a) => a !== '--json' && !a.startsWith('--out'));
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node scripts/mesh-report.mjs ./mesh-test-runs/<run-id>[.json] [...] [--json] [--out=rapport.md]`);
  process.exit(args.length === 0 ? 1 : 0);
}

function resolveRunArg(arg) {
  const candidates = [arg, `${arg}.json`, `mesh-test-runs/${arg}.json`, `mesh-test-runs/${arg}`];
  for (const c of candidates) {
    try { if (existsSync(resolve(c))) return c; } catch { /* ignore */ }
  }
  fail(`run introuvable: ${arg} (attendu : fichier .json normalisé par mesh-capture)`);
}

function loadRun(file) {
  let raw;
  try { raw = JSON.parse(readFileSync(resolve(file), 'utf8')); }
  catch (e) { fail(`${file}: lecture/JSON impossible (${e.message})`); }
  if (!raw || raw.v !== 1 || !Array.isArray(raw.sessions) || !Array.isArray(raw.events)) {
    fail(`${file}: format inattendu (passer par scripts/mesh-capture.mjs d'abord)`);
  }
  for (const s of raw.sessions) {
    if (s.provenance !== 'real-device' && s.provenance !== 'mock') {
      fail(`${file}: session #${s.sessionIndex ?? '?'} sans provenance explicite (real-device|mock) — refus de conclure`);
    }
  }
  return { file, ...raw };
}

const runs = args.map((a) => loadRun(resolveRunArg(a)));
const sessions = runs.flatMap((r) => r.sessions.map((s) => ({ ...s, runId: r.runId, scenario: r.scenario })));
const events = runs.flatMap((r) => r.events.map((e) => ({ ...e, runId: r.runId })));
const key = (e) => `${e.runId}#${e.sessionIndex}`;
const realSessionIdx = new Set(sessions.filter((s) => s.provenance === 'real-device').map((s) => `${s.runId}#${s.sessionIndex}`));
const isReal = (e) => realSessionIdx.has(key(e));
const realEvents = events.filter(isReal);

const sessionByKey = new Map(sessions.map((s) => [`${s.runId}#${s.sessionIndex}`, s]));
const netBySession = new Map();
for (const e of events) {
  if (e.t === 'session' && typeof e.net === 'string') netBySession.set(key(e), e.net);
}
// DataChannel réellement ouvert par session (dc open OU dcStats avec vie > 0).
const dcOpenBySession = new Map();
for (const e of realEvents) {
  if ((e.t === 'dc' && e.state === 'open') || (e.t === 'dcStats' && Number(e.lifetimeMs) > 0)) {
    dcOpenBySession.set(key(e), true);
  }
}

const count = (list, pred) => list.reduce((n, e) => n + (pred(e) ? 1 : 0), 0);
const sum = (list, fn) => list.reduce((n, e) => n + (fn(e) || 0), 0);
const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);

// ---- WebRTC ---------------------------------------------------------------
const iceResults = realEvents.filter((e) => e.t === 'iceResult');
const iceOk = iceResults.filter((e) => e.ok);
const iceKo = iceResults.filter((e) => !e.ok);
const pairs = realEvents.filter((e) => e.t === 'candidatePair');
const pairDist = {};
for (const p of pairs) {
  const k = `${p.local ?? '?'}→${p.remote ?? '?'}`;
  pairDist[k] = (pairDist[k] ?? 0) + 1;
}
const dcOpen = count(realEvents, (e) => e.t === 'dc' && e.state === 'open');
const dcClose = count(realEvents, (e) => e.t === 'dc' && e.state === 'close');
const dcError = count(realEvents, (e) => e.t === 'dc' && e.state === 'error');
const dcStats = realEvents.filter((e) => e.t === 'dcStats');
const hellos = realEvents.filter((e) => e.t === 'hello');
const helloOk = count(hellos, (e) => e.ok);
const backpressure = count(realEvents, (e) => e.t === 'backpressure');
// Sessions avec ICE ok : base du DATACHANNEL_SUCCESS_RATE.
const iceOkSessions = new Set(iceOk.map((e) => key(e)));
const dcOpenSessions = new Set([...dcOpenBySession.keys()].filter((k) => realSessionIdx.has(k)));
const dcSuccessRate = iceOkSessions.size === 0 ? null
  : [...iceOkSessions].filter((k) => dcOpenSessions.has(k)).length / iceOkSessions.size;

// ---- P2P ------------------------------------------------------------------
const transfersReq = realEvents.filter((e) => e.t === 'transfer' && e.role === 'req');
const transfersSrv = realEvents.filter((e) => e.t === 'transfer' && e.role === 'srv');
const transfersReqOk = transfersReq.filter((e) => e.ok);
const tiers = realEvents.filter((e) => e.t === 'tier');
const tierCount = (name) => count(tiers, (e) => e.tier === name);
const fallbacks = realEvents.filter((e) => e.t === 'fallback');
const fallbackByReason = {};
for (const f of fallbacks) fallbackByReason[f.reason ?? '?'] = (fallbackByReason[f.reason ?? '?'] ?? 0) + 1;

let peerBytesStats = 0, originBytesStats = 0, peerHitsStats = 0, originHitsStats = 0, memHitsStats = 0, idbHitsStats = 0;
for (const s of sessions.filter((s) => s.provenance === 'real-device')) {
  peerBytesStats += s.stats?.bytesFromPeers ?? 0;
  originBytesStats += s.stats?.bytesFromOrigin ?? 0;
  peerHitsStats += s.stats?.peerHits ?? 0;
  originHitsStats += s.stats?.originHits ?? 0;
  memHitsStats += s.stats?.memoryHits ?? 0;
  idbHitsStats += s.stats?.persistentCacheHits ?? 0;
}
const segDen = peerHitsStats + originHitsStats;
const byteDen = peerBytesStats + originBytesStats;
const PEER_SEGMENT_RATIO = segDen === 0 ? null : peerHitsStats / segDen;
const ORIGIN_SEGMENT_RATIO = segDen === 0 ? null : originHitsStats / segDen;
const PEER_BYTE_RATIO = byteDen === 0 ? null : peerBytesStats / byteDen;
const ORIGIN_BYTE_RATIO = byteDen === 0 ? null : originBytesStats / byteDen;
const tierTotal = tierCount('peer') + tierCount('origin') + tierCount('memory') + tierCount('idb');
const CACHE_RATIO = tierTotal === 0 ? null : (tierCount('memory') + tierCount('idb')) / tierTotal;

// ---- Qualité ---------------------------------------------------------------
const timeouts = count(transfersReq, (e) => !e.ok && e.reason === 'timeout') + count(realEvents, (e) => e.t === 'peerResult' && !e.ok && e.reason === 'timeout');
const hashFails = count(transfersReq, (e) => !e.ok && e.reason === 'hash') + sessions.filter((s) => s.provenance === 'real-device').reduce((n, s) => n + (s.stats?.peerHashFailures ?? 0), 0);
const TIMEOUT_RATE = transfersReq.length === 0 ? null : timeouts / transfersReq.length;
const HASH_FAILURE_RATE = transfersReq.length === 0 ? null : hashFails / transfersReq.length;
const FALLBACK_RATE = transfersReq.length === 0 ? null : fallbacks.length / transfersReq.length;
const stalls = realEvents.filter((e) => e.t === 'stall');
const stallDurs = stalls.map((e) => Number(e.durMs) || 0);
// Heures observées ≈ somme des empans rel par session réelle (horloges locales).
const spanBySession = new Map();
for (const e of realEvents) {
  if (typeof e.rel !== 'number') continue;
  const k = key(e);
  const cur = spanBySession.get(k) ?? { min: e.rel, max: e.rel };
  if (e.rel < cur.min) cur.min = e.rel;
  if (e.rel > cur.max) cur.max = e.rel;
  spanBySession.set(k, cur);
}
const observedHours = [...spanBySession.values()].reduce((n, s) => n + Math.max(0, s.max - s.min) / 3600000, 0);
const STALL_RATE = observedHours <= 0 ? null : stalls.length / observedHours;
const playErrors = realEvents.filter((e) => e.t === 'playError');
const kills = realEvents.filter((e) => e.t === 'kill');

// ---- Corrélation A↔B (jointure stricte sur tid) ------------------------------
const byTid = new Map();
for (const e of realEvents.filter((e) => e.t === 'transfer' && typeof e.tid === 'string')) {
  if (!byTid.has(e.tid)) byTid.set(e.tid, []);
  byTid.get(e.tid).push(e);
}
const swarmOf = (e) => sessionByKey.get(key(e))?.swarm ?? 'unknown';
const correlated = [];
const nearMiss = [];
for (const [tid, list] of byTid) {
  const req = list.find((e) => e.role === 'req');
  const srv = list.find((e) => e.role === 'srv');
  if (!req || !srv) continue; // un seul côté exporté : pas une preuve, pas un échec
  const problems = [];
  if (!req.ok || !srv.ok) problems.push('transfert non ok des deux côtés');
  if ((req.bytes ?? 0) <= 0) problems.push('octets nuls');
  if (req.cc !== srv.cc || req.sn !== srv.sn) problems.push('(cc,sn) divergents');
  if (swarmOf(req) === 'unknown' || swarmOf(srv) === 'unknown' || swarmOf(req) !== swarmOf(srv)) problems.push('swarm différent ou inconnu');
  if (!dcOpenBySession.get(key(req)) || !dcOpenBySession.get(key(srv))) problems.push('DataChannel non démontré ouvert des deux côtés');
  if (problems.length === 0) {
    const tierPeer = tiers.some((t) => t.cc === req.cc && t.sn === req.sn && t.tier === 'peer' && key(t) === key(req));
    correlated.push({ tid, cc: req.cc, sn: req.sn, bytes: req.bytes, reqMs: req.ms, srvMs: srv.ms, swarm: swarmOf(req), tierPeer });
  } else {
    nearMiss.push({ tid: `${String(tid).slice(0, 8)}…`, reasons: problems });
  }
}
const REAL_P2P_VIDEO = correlated.length > 0 ? 'VALIDATED' : 'NOT_VALIDATED';

// ---- TURN (3 états, jamais sur observations isolées) -------------------------
const byDevice = {};
for (const e of iceResults) {
  const s = sessionByKey.get(key(e));
  const dc = s?.deviceClass ?? 'unknown';
  byDevice[dc] = byDevice[dc] ?? { attempts: 0, ok: 0, ko: 0 };
  byDevice[dc].attempts += 1;
  if (e.ok) byDevice[dc].ok += 1; else byDevice[dc].ko += 1;
}
const byNet = {};
for (const e of iceResults) {
  const net = netBySession.get(key(e)) ?? 'unknown';
  byNet[net] = byNet[net] ?? { attempts: 0, ok: 0, ko: 0 };
  byNet[net].attempts += 1;
  if (e.ok) byNet[net].ok += 1; else byNet[net].ko += 1;
}
const relayPairs = count(pairs, (e) => e.local === 'relay' || e.remote === 'relay');
const ICE_SUCCESS_RATE = iceResults.length === 0 ? null : iceOk.length / iceResults.length;
const TURN_DECISION = iceResults.length < MIN_ICE_FOR_TURN ? 'INSUFFICIENT_DATA'
  : (ICE_SUCCESS_RATE ?? 0) >= TURN_SUCCESS_THRESHOLD ? 'NO_TURN_NEEDED_YET' : 'TURN_RECOMMENDED';

// ---- Résilience A→B→C (NOT_OBSERVED / PARTIAL / DEMONSTRATED) ------------------
// Chaîne : un pair Y qui a REÇU (req ok) ET SERVI (srv ok) relie X→Y→Z.
// Disparition : iceResult!ok ou dc close après open, dans le même run+swarm.
// Reprise : fallback suivi d'un tier origin (même session) ou d'un req ok
// vers un autre pair (même run).
let recoveredViaPeer = 0, recoveredViaOrigin = 0, fallbackBroken = 0;
for (const f of fallbacks) {
  const sameSegTierOrigin = tiers.some((t) => t.runId === f.runId && t.sessionIndex === f.sessionIndex && t.cc === f.cc && t.sn === f.sn && t.tier === 'origin');
  if (sameSegTierOrigin) recoveredViaOrigin += 1;
  const otherPeerOk = transfersReq.some((t) => t.runId === f.runId && t.cc === f.cc && t.sn === f.sn && t.ok && t.sessionIndex !== f.sessionIndex);
  if (otherPeerOk) recoveredViaPeer += 1;
  if (!sameSegTierOrigin && !otherPeerOk) fallbackBroken += 1;
}
const disappearance = realEvents.filter((e) => (e.t === 'iceResult' && !e.ok) || (e.t === 'dc' && e.state === 'close'));
const servedBy = new Map(); // peerLabel(session) -> Set(tid) servis
const fetchedBy = new Map();
for (const e of [...transfersReqOk, ...transfersSrv.filter((t) => t.ok)]) {
  const peer = sessionByKey.get(key(e))?.peer ?? key(e);
  const map = e.role === 'srv' ? servedBy : fetchedBy;
  if (!map.has(peer)) map.set(peer, new Set());
  map.get(peer).add(e.tid);
}
const middlePeers = [...servedBy.keys()].filter((p) => fetchedBy.has(p));
const chain = middlePeers.length > 0 && new Set([...servedBy.keys(), ...fetchedBy.keys()]).size >= 3;
const recoveryObserved = recoveredViaOrigin > 0 || recoveredViaPeer > 0;
const RESILIENCE_A_B_C = (chain && disappearance.length > 0 && recoveryObserved) ? 'DEMONSTRATED'
  : (recoveryObserved || chain) ? 'PARTIAL' : 'NOT_OBSERVED';

// ---- Décision canary ----------------------------------------------------------
const stallMax = stallDurs.length ? Math.max(...stallDurs) : 0;
const stopFlags = [];
if (stallMax > STALL_STOP_MS) stopFlags.push(`stall > 5 s observé (${stallMax} ms)`);
if (playErrors.length >= PLAY_ERROR_STOP) stopFlags.push(`${playErrors.length} erreurs de lecture`);
if (hashFails >= HASH_STOP) stopFlags.push(`${hashFails} hash failures (corruptions répétées)`);
if (fallbackBroken > 0) stopFlags.push(`fallback origin cassé ×${fallbackBroken} (repli sans reprise tracée)`);
const DECISION_CANARY = stopFlags.length > 0 ? 'STOP'
  : (REAL_P2P_VIDEO === 'VALIDATED' && (ICE_SUCCESS_RATE ?? 0) >= TURN_SUCCESS_THRESHOLD && stallMax <= STALL_WARN_MS && (FALLBACK_RATE ?? 1) < EXPAND_MAX_FALLBACK) ? 'EXPAND'
    : 'CONTINUE';
// Seuils EXPAND provisoires (décision finale = opérateur) : P2P prouvé +
// ICE ≥ 60 % + aucun stall > 2 s + repli < 50 %. CONTINUE = poursuivre au
// même palier (données insuffisantes ou preuve manquante, sans signal STOP).

const mockSessions = sessions.filter((s) => s.provenance !== 'real-device').length;

const metrics = {
  REAL_P2P_VIDEO,
  ICE_SUCCESS_RATE,
  DATACHANNEL_SUCCESS_RATE: dcSuccessRate,
  PEER_SEGMENT_RATIO,
  PEER_BYTE_RATIO,
  ORIGIN_SEGMENT_RATIO,
  ORIGIN_BYTE_RATIO,
  CACHE_RATIO,
  FALLBACK_RATE,
  HASH_FAILURE_RATE,
  TIMEOUT_RATE,
  STALL_RATE,
  RESILIENCE_A_B_C,
  TURN_DECISION,
  DECISION_CANARY,
};

const report = {
  generatedAt: new Date().toISOString(),
  runs: runs.map((r) => ({ runId: r.runId, scenario: r.scenario, sessions: r.sessions.length, events: r.events.length, file: r.file })),
  sessions: { total: sessions.length, realDevice: sessions.length - mockSessions, mock: mockSessions },
  metrics,
  stopFlags,
  webrtc: {
    attempts: iceResults.length, success: iceOk.length, failed: iceKo.length,
    avgConnectMs: iceOk.length ? Math.round(avg(iceOk.map((e) => Number(e.ms) || 0))) : null,
    pairDistribution: pairDist,
    dc: { open: dcOpen, close: dcClose, error: dcError, sessionsWithOpen: dcOpenSessions.size, sessionsWithIceOk: iceOkSessions.size },
    dcStats: dcStats.length ? {
      links: dcStats.length, avgLifetimeMs: Math.round(avg(dcStats.map((e) => Number(e.lifetimeMs) || 0))),
      sentBytes: sum(dcStats, (e) => Number(e.sentBytes)), recvBytes: sum(dcStats, (e) => Number(e.recvBytes)),
      backpressure, timeouts: sum(dcStats, (e) => Number(e.timeouts)), aborts: sum(dcStats, (e) => Number(e.aborts)), errors: sum(dcStats, (e) => Number(e.errors)),
    } : null,
    hello: { total: hellos.length, accepted: helloOk, refused: hellos.length - helloOk },
  },
  p2p: {
    transfersRequested: transfersReq.length, transfersOk: transfersReqOk.length,
    transfersServed: count(transfersSrv, (e) => e.ok),
    tier: { peer: tierCount('peer'), origin: tierCount('origin'), memory: tierCount('memory'), idb: tierCount('idb') },
    statsSums: { peerHits: peerHitsStats, originHits: originHitsStats, memoryHits: memHitsStats, idbHits: idbHitsStats, peerBytes: peerBytesStats, originBytes: originBytesStats },
    correlatedTransfers: correlated.length,
    nearMiss: nearMiss.slice(0, 10),
  },
  quality: {
    timeouts, hashFailures: hashFails, fallbackTotal: fallbacks.length, fallbackByReason, fallbackBroken,
    stalls: { count: stalls.length, totalMs: stallDurs.reduce((a, b) => a + b, 0), maxMs: stallMax, avgMs: stallDurs.length ? Math.round(avg(stallDurs)) : 0, observedHours: Math.round(observedHours * 100) / 100 },
    playErrors: playErrors.length,
    killEvents: kills.length,
  },
  resilience: { fallbackObserved: fallbacks.length, recoveredViaOrigin, recoveredViaPeer, disappearance: disappearance.length, chainMiddlePeers: middlePeers.length, state: RESILIENCE_A_B_C },
  turn: { attempts: iceResults.length, success: iceOk.length, failed: iceKo.length, byDevice, byNet, relayPairs, threshold: TURN_SUCCESS_THRESHOLD, minAttempts: MIN_ICE_FOR_TURN },
  evidence: correlated.slice(0, 10).map((c) => ({ tid: `${String(c.tid).slice(0, 8)}…`, seg: `${c.cc}:${c.sn}`, swarm: c.swarm, bytes: c.bytes, reqMs: c.reqMs, srvMs: c.srvMs, tierPeer: c.tierPeer })),
};

function fmtRate(v) { return v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)} %`; }
function fmtRateH(v) { // taux horaires (stalls/h)
  return v === null || v === undefined ? 'n/a' : `${v.toFixed(1)}/h`;
}
function fmtBytes(n) {
  if (!n) return '0 o';
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / 1024 / 1024).toFixed(2)} Mo`;
}
const okLine = (label, value) => `│ ${label.padEnd(28)} │ ${(value ?? 'n/a').toString().padEnd(10)} │`;

const lines = [];
lines.push(`# Rapport MeshStream — phase canary (test contrôlé)`);
lines.push(``);
lines.push(`Généré : ${report.generatedAt}`);
lines.push(`Runs : ${report.runs.map((r) => `${r.runId}${r.scenario ? ` (scénario ${r.scenario})` : ''} — ${r.sessions} session(s), ${r.events} événement(s)`).join(' · ')}`);
lines.push(`Sessions : ${report.sessions.total} au total (${report.sessions.realDevice} real-device, ${report.sessions.mock} mock) — seules les real-device comptent ci-dessous.`);
lines.push(``);
lines.push(`## REAL_P2P_VIDEO = ${REAL_P2P_VIDEO}`);
if (REAL_P2P_VIDEO === 'VALIDATED') {
  lines.push(`Preuve : ${correlated.length} transfert(s) corrélé(s) — req+srv ok, même tid, même (cc,sn), même swarm, octets > 0, DataChannel ouvert des deux côtés. Exemples :`);
  for (const e of report.evidence) lines.push(`- tid ${e.tid} seg ${e.seg} swarm ${e.swarm} ${fmtBytes(e.bytes)} (req ${e.reqMs} ms / srv ${e.srvMs} ms) tier peer injecté : ${e.tierPeer ? 'oui' : 'non observé'}`);
} else {
  lines.push(`Aucune preuve complète (req+srv, même tid/swarm/segment, octets > 0, DC ouvert bilatéral) sur appareils réels.`);
  if (nearMiss.length) lines.push(`Pistes incomplètes (tid des deux côtés mais preuve partielle) : ${nearMiss.map((n) => `${n.tid} (${n.reasons.join('; ')})`).join(' · ')}`);
  lines.push(`Critère : deux appareils physiques doivent réellement échanger un segment via DataChannel — NON DÉMONTRÉ à ce stade. Ne pas élargir le trafic.`);
}
lines.push(``);
lines.push(`## Métriques (résumé machine : --json)`);
lines.push(`- ICE_SUCCESS_RATE : ${fmtRate(ICE_SUCCESS_RATE)} (${iceOk.length}/${iceResults.length})`);
lines.push(`- DATACHANNEL_SUCCESS_RATE : ${fmtRate(dcSuccessRate)} (sessions ICE-ok avec DC ouvert : ${dcOpenSessions.size}/${iceOkSessions.size})`);
lines.push(`- PEER_SEGMENT_RATIO : ${fmtRate(PEER_SEGMENT_RATIO)} (${peerHitsStats}/${segDen}) · ORIGIN_SEGMENT_RATIO : ${fmtRate(ORIGIN_SEGMENT_RATIO)}`);
lines.push(`- PEER_BYTE_RATIO : ${fmtRate(PEER_BYTE_RATIO)} (${fmtBytes(peerBytesStats)}) · ORIGIN_BYTE_RATIO : ${fmtRate(ORIGIN_BYTE_RATIO)}`);
lines.push(`- CACHE_RATIO (memory+idb / tiers) : ${fmtRate(CACHE_RATIO)}`);
lines.push(`- FALLBACK_RATE : ${fmtRate(FALLBACK_RATE)} · TIMEOUT_RATE : ${fmtRate(TIMEOUT_RATE)} · HASH_FAILURE_RATE : ${fmtRate(HASH_FAILURE_RATE)}`);
lines.push(`- STALL_RATE : ${fmtRateH(STALL_RATE)} (${stalls.length} stalls en ~${report.quality.stalls.observedHours} h observées, max ${stallMax} ms) · erreurs lecture : ${playErrors.length}`);
lines.push(`- RESILIENCE_A_B_C : ${RESILIENCE_A_B_C} (chaîne ×${middlePeers.length} pairs relais, disparitions ×${disappearance.length}, reprises origin ×${recoveredViaOrigin} / peer ×${recoveredViaPeer})`);
lines.push(``);
lines.push(`## Tableau de décision`);
lines.push(`┌──────────────────────────────┬────────────┐`);
lines.push(okLine('Critère', 'Résultat'));
lines.push(`├──────────────────────────────┼────────────┤`);
lines.push(okLine('ICE réel', ICE_SUCCESS_RATE === null ? 'NON TESTÉ' : `${(ICE_SUCCESS_RATE * 100).toFixed(0)} % (${iceOk.length}/${iceResults.length})`));
lines.push(okLine('DataChannel réel', dcSuccessRate === null ? 'NON TESTÉ' : `${(dcSuccessRate * 100).toFixed(0)} %`));
lines.push(okLine('Segment P2P réel', REAL_P2P_VIDEO === 'VALIDATED' ? `OUI ×${correlated.length}` : 'NON'));
lines.push(okLine('Offload', PEER_BYTE_RATIO === null ? 'NON MESURÉ' : `${(PEER_BYTE_RATIO * 100).toFixed(0)} % octets`));
lines.push(okLine('Stall', stalls.length === 0 ? 'aucun' : `×${stalls.length} (max ${stallMax} ms)`));
lines.push(okLine('Fallback', fallbacks.length === 0 ? 'aucun' : `${(FALLBACK_RATE * 100).toFixed(0)} %`));
lines.push(okLine('Résilience', RESILIENCE_A_B_C));
lines.push(okLine('CGNAT', Object.keys(byNet).length <= 1 && pairs.length < 3 ? 'MATRICE INCOMPLÈTE' : `${Object.keys(byNet).join(',')}`));
lines.push(okLine('Android/WebView', sessions.some((s) => s.provenance === 'real-device' && ['mobile', 'tv', 'webview'].includes(s.deviceClass)) ? 'OBSERVÉ' : 'NON TESTÉ'));
lines.push(okLine('TURN', TURN_DECISION));
lines.push(`└──────────────────────────────┴────────────┘`);
lines.push(``);
lines.push(`DECISION CANARY: ${DECISION_CANARY}`);
lines.push(`DECISION TURN: ${TURN_DECISION}`);
if (stopFlags.length) lines.push(`Signaux STOP : ${stopFlags.join(' · ')}`);
if (DECISION_CANARY === 'EXPAND') lines.push(`Seuils EXPAND provisoires remplis (P2P prouvé, ICE ≥ 60 %, stall ≤ 2 s, repli < 50 %) — décision finale = opérateur, palier suivant uniquement.`);
if (DECISION_CANARY === 'CONTINUE') lines.push(`Poursuivre au même palier (preuve ou volume manquant, sans signal STOP). Ne pas élargir.`);
lines.push(``);
lines.push(`## WebRTC (appareils réels uniquement)`);
lines.push(`- Tentatives ICE : ${iceResults.length} · réussies : ${iceOk.length} · échouées : ${iceKo.length}`);
lines.push(`- Durée moyenne de connexion (succès) : ${iceOk.length ? Math.round(avg(iceOk.map((e) => Number(e.ms) || 0))) : 'n/a'} ms`);
lines.push(`- Paires host/srflx/relay : ${Object.keys(pairDist).length ? Object.entries(pairDist).map(([k, v]) => `${k} ×${v}`).join(', ') : 'aucune paire observée'}`);
lines.push(`- DataChannel : open ×${dcOpen} · close ×${dcClose} · error ×${dcError} · HELLO acceptés ${helloOk}/${hellos.length} · backpressure ×${backpressure}`);
if (report.webrtc.dcStats) lines.push(`- Vie moyenne des liens : ${report.webrtc.dcStats.avgLifetimeMs} ms · émis ${fmtBytes(report.webrtc.dcStats.sentBytes)} · reçus ${fmtBytes(report.webrtc.dcStats.recvBytes)} · timeouts ${report.webrtc.dcStats.timeouts} · aborts ${report.webrtc.dcStats.aborts} · errors ${report.webrtc.dcStats.errors}`);
lines.push(``);
lines.push(`## P2P (appareils réels uniquement)`);
lines.push(`- Transferts demandés (req) : ${transfersReq.length} · réussis : ${transfersReqOk.length} · servis (srv ok) : ${count(transfersSrv, (e) => e.ok)}`);
lines.push(`- Tiers loader : peer ×${tierCount('peer')} · origin ×${tierCount('origin')} · memory ×${tierCount('memory')} · idb ×${tierCount('idb')}`);
lines.push(`- Transferts corrélés A↔B : ${correlated.length}${nearMiss.length ? ` · pistes incomplètes : ${nearMiss.length}` : ''}`);
lines.push(``);
lines.push(`## Qualité`);
lines.push(`- Timeouts : ${timeouts} · hash failures : ${hashFails} · fallbacks : ${fallbacks.length} (${Object.entries(fallbackByReason).map(([k, v]) => `${k} ×${v}`).join(', ') || 'aucun'}) · repli cassé (sans reprise) : ×${fallbackBroken}`);
lines.push(`- Stalls : ${stalls.length} (total ${stallDurs.reduce((a, b) => a + b, 0)} ms, max ${stallMax} ms) · erreurs lecture : ${playErrors.length} · kill-switch : ${kills.length} événement(s)`);
lines.push(`- Sessions P2P (peerHits > 0) vs origin-only : ${sessions.filter((s) => s.provenance === 'real-device' && (s.stats?.peerHits ?? 0) > 0).length} vs ${sessions.filter((s) => s.provenance === 'real-device' && (s.stats?.peerHits ?? 0) === 0).length} (comparer stalls/erreurs entre les deux groupes avant toute conclusion)`);
lines.push(``);
lines.push(`## Résilience`);
if (fallbacks.length === 0 && disappearance.length === 0) lines.push(`- Aucun repli ni disparition observé (scénario C « disparition du peer » NON TESTÉ → RESILIENCE_A_B_C = NOT_OBSERVED).`);
else lines.push(`- Replis : ${fallbacks.length} · reprise via origin ×${recoveredViaOrigin} · via un autre peer ×${recoveredViaPeer} · disparitions ×${disappearance.length} · pairs relais (chaîne) ×${middlePeers.length} → ${RESILIENCE_A_B_C}`);
lines.push(`- Exigence : peerResult en échec → tier origin sous ≤ timeout (1,5 s défaut), aucun blocage loader, stall > 5 s = STOP.`);
lines.push(``);
lines.push(`## TURN DECISION : ${TURN_DECISION}`);
lines.push(`- Tentatives ICE : ${iceResults.length} · succès : ${iceOk.length} · échecs : ${iceKo.length} (seuil : ≥ ${MIN_ICE_FOR_TURN} tentatives, succès ≥ ${(TURN_SUCCESS_THRESHOLD * 100).toFixed(0)} %)`);
lines.push(`- Par classe d'appareil : ${Object.keys(byDevice).length ? Object.entries(byDevice).map(([k, v]) => `${k} ${v.ok}/${v.attempts}`).join(' · ') : 'n/a'}`);
lines.push(`- Par réseau : ${Object.keys(byNet).length ? Object.entries(byNet).map(([k, v]) => `${k} ${v.ok}/${v.attempts}`).join(' · ') : 'n/a'}`);
lines.push(`- Paires via relay observées : ${relayPairs} (aucun TURN configuré : 0 attendu) · échecs : ${iceKo.length}`);
if (TURN_DECISION === 'INSUFFICIENT_DATA') lines.push(`- Volume insuffisant : NE PAS installer TURN. Ne jamais décider TURN sur 1-2 échecs.`);
else if (TURN_DECISION === 'NO_TURN_NEEDED_YET') lines.push(`- Taux de succès suffisant : pas de TURN pour l'instant. Réévaluer à chaque palier.`);
else lines.push(`- Taux de succès < ${(TURN_SUCCESS_THRESHOLD * 100).toFixed(0)} % sur volume suffisant : recommandation = PILOTER TURN (étape dédiée), pas déployer en production.`);
lines.push(``);
lines.push(`## Statut de preuve (ne jamais mélanger)`);
lines.push(`- PROUVÉ EN PRODUCTION : signaling, auth, kill-switch, polling, WebSocket (batterie §6 edge + runbook étape 6 — hors captures, voir docs/operations/meshstream-step6-validation.md).`);
lines.push(`- PROUVÉ PAR MOCK : PeerLink, DataChannel, scoring, loader (tests unitaires : packages/mesh + workers — ${transfersReq.length ? 'complétés par' : 'sans'} observations réelles ci-dessus).`);
lines.push(`- PROUVÉ SUR APPAREILS RÉELS : ${correlated.length ? `${correlated.length} transfert(s) corrélé(s), ICE ${iceOk.length}/${iceResults.length}, offload ${fmtRate(PEER_BYTE_RATIO)}` : 'RIEN pour l\'instant (aucune preuve tid complète)'} — seul ce qui est ci-dessus compte.`);
lines.push(`- NON TESTÉ : ${[
  fallbacks.length ? null : 'résilience disparition du peer',
  stalls.length ? null : 'stalls en conditions réelles',
  pairs.length < 3 ? 'matrice CGNAT multi-réseaux' : null,
  sessions.some((s) => s.provenance === 'real-device' && ['mobile', 'tv', 'webview'].includes(s.deviceClass)) ? null : 'Android/WebView/Android TV',
  TURN_DECISION === 'INSUFFICIENT_DATA' ? 'décision TURN (données insuffisantes)' : null,
].filter(Boolean).join(' · ') || 'voir sections ci-dessus'}.`);
lines.push(``);
lines.push(`## STOP CONDITIONS (rappel opérateur)`);
lines.push(`kill-switch + canary OFF immédiats si : stall > 5 s · erreurs lecture en hausse · fallback origin cassé · boucle WebRTC · CPU/réseau/mémoire anormaux · crash · P2P non désactivable · comportement différent chez les utilisateurs non autorisés · fuite token/IP/URL dans la télémétrie. Conserver les logs, générer ce rapport, ne pas élargir.`);

const text = `${lines.join('\n')}\n`;
if (asJson) {
  const payload = JSON.stringify(report, null, 2);
  if (outPath) writeFileSync(outPath, `${payload}\n`);
  else console.log(payload);
} else if (outPath) {
  writeFileSync(outPath, text);
  console.error(`mesh-report: rapport écrit → ${outPath}`);
  console.log(text);
} else {
  console.log(text);
}
