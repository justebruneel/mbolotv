#!/usr/bin/env node
// ============================================================================
// mesh-report.mjs — Rapport canary MeshStream à partir de runs normalisés.
//
// Usage :
//   node scripts/mesh-report.mjs ./mesh-test-runs/*.json [--json] [--out rapport.md]
//
// Le rapport NE TRANSFORME JAMAIS un résultat mock en résultat réel : chaque
// section « appareils réels » ne compte que les sessions provenance=real-device.
// Tant que deux appareils physiques n'ont pas échangé un segment via DataChannel
// (jointure req+srv sur le même tid, octets > 0), le rapport affiche :
//   REAL_P2P_VIDEO = NOT_VALIDATED
// La décision TURN exige ≥ 10 tentatives ICE, sinon INSUFFICIENT_DATA.
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIN_ICE_FOR_TURN = 10;

function fail(msg) { console.error(`mesh-report: ERREUR: ${msg}`); process.exit(1); }

const args = process.argv.slice(2).filter((a) => a !== '--json' && !a.startsWith('--out'));
const asJson = process.argv.includes('--json');
const outArg = process.argv.find((a) => a.startsWith('--out'));
const outPath = outArg ? resolve(outArg.split('=')[1] ?? outArg) : null;
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node scripts/mesh-report.mjs ./mesh-test-runs/*.json [--json] [--out=rapport.md]`);
  process.exit(args.length === 0 ? 1 : 0);
}

function loadRun(file) {
  let raw;
  try { raw = JSON.parse(readFileSync(resolve(file), 'utf8')); }
  catch (e) { fail(`${file}: lecture/JSON impossible (${e.message})`); }
  if (!raw || raw.v !== 1 || !Array.isArray(raw.sessions) || !Array.isArray(raw.events)) {
    fail(`${file}: format inattendu (passer par scripts/mesh-capture.mjs d'abord)`);
  }
  return { file, ...raw };
}

const runs = args.map(loadRun);
const sessions = runs.flatMap((r) => r.sessions.map((s) => ({ ...s, runId: r.runId, scenario: r.scenario })));
const events = runs.flatMap((r) => r.events.map((e) => ({ ...e, runId: r.runId })));
const realSessionIdx = new Set(sessions.filter((s) => s.provenance === 'real-device').map((s) => `${s.runId}#${s.sessionIndex}`));
const isReal = (e) => realSessionIdx.has(`${e.runId}#${e.sessionIndex}`);
const realEvents = events.filter(isReal);

const sessionByKey = new Map(sessions.map((s) => [`${s.runId}#${s.sessionIndex}`, s]));
// Réseau par session (dernier événement session vu, sinon unknown).
const netBySession = new Map();
for (const e of events) {
  if (e.t === 'session' && typeof e.net === 'string') netBySession.set(`${e.runId}#${e.sessionIndex}`, e.net);
}

const count = (list, pred) => list.reduce((n, e) => n + (pred(e) ? 1 : 0), 0);
const sum = (list, fn) => list.reduce((n, e) => n + (fn(e) || 0), 0);
const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
const pct = (n, d) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)} %`);

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
const segOffload = (peerHitsStats + originHitsStats) === 0 ? null : peerHitsStats / (peerHitsStats + originHitsStats);
const byteOffload = (peerBytesStats + originBytesStats) === 0 ? null : peerBytesStats / (peerBytesStats + originBytesStats);

// ---- Qualité ---------------------------------------------------------------
const timeouts = count(transfersReq, (e) => !e.ok && e.reason === 'timeout') + count(realEvents, (e) => e.t === 'peerResult' && !e.ok && e.reason === 'timeout');
const hashFails = count(transfersReq, (e) => !e.ok && e.reason === 'hash') + sessions.filter((s) => s.provenance === 'real-device').reduce((n, s) => n + (s.stats?.peerHashFailures ?? 0), 0);
const stalls = realEvents.filter((e) => e.t === 'stall');
const stallDurs = stalls.map((e) => Number(e.durMs) || 0);
const playErrors = realEvents.filter((e) => e.t === 'playError');
const kills = realEvents.filter((e) => e.t === 'kill');

// ---- Corrélation A↔B (jointure sur tid) ------------------------------------
const byTid = new Map();
for (const e of realEvents.filter((e) => e.t === 'transfer' && typeof e.tid === 'string')) {
  if (!byTid.has(e.tid)) byTid.set(e.tid, []);
  byTid.get(e.tid).push(e);
}
const correlated = [];
for (const [tid, list] of byTid) {
  const req = list.find((e) => e.role === 'req');
  const srv = list.find((e) => e.role === 'srv');
  if (req && srv && req.ok && srv.ok && (req.bytes ?? 0) > 0 && req.cc === srv.cc && req.sn === srv.sn) {
    const tierPeer = tiers.find((t) => t.cc === req.cc && t.sn === req.sn && t.tier === 'peer');
    correlated.push({ tid, cc: req.cc, sn: req.sn, bytes: req.bytes, reqMs: req.ms, srvMs: srv.ms, tierPeer: Boolean(tierPeer) });
  }
}
const realP2p = correlated.length > 0 ? 'VALIDATED' : 'NOT_VALIDATED';

// ---- TURN ------------------------------------------------------------------
const byDevice = {};
for (const e of iceResults) {
  const s = sessionByKey.get(`${e.runId}#${e.sessionIndex}`);
  const dc = s?.deviceClass ?? 'unknown';
  byDevice[dc] = byDevice[dc] ?? { attempts: 0, ok: 0, ko: 0 };
  byDevice[dc].attempts += 1;
  if (e.ok) byDevice[dc].ok += 1; else byDevice[dc].ko += 1;
}
const byNet = {};
for (const e of iceResults) {
  const net = netBySession.get(`${e.runId}#${e.sessionIndex}`) ?? 'unknown';
  byNet[net] = byNet[net] ?? { attempts: 0, ok: 0, ko: 0 };
  byNet[net].attempts += 1;
  if (e.ok) byNet[net].ok += 1; else byNet[net].ko += 1;
}
const relayPairs = count(pairs, (e) => e.local === 'relay' || e.remote === 'relay');
const turnVerdict = iceResults.length < MIN_ICE_FOR_TURN ? 'INSUFFICIENT_DATA' : 'DATA_SUFFICIENT';

// ---- Résilience (heuristique honnête) ---------------------------------------
let recoveredViaPeer = 0, recoveredViaOrigin = 0;
for (const f of fallbacks) {
  const sameSegTierOrigin = tiers.some((t) => t.runId === f.runId && t.sessionIndex === f.sessionIndex && t.cc === f.cc && t.sn === f.sn && t.tier === 'origin');
  if (sameSegTierOrigin) recoveredViaOrigin += 1;
  const otherPeerOk = transfersReq.some((t) => t.runId === f.runId && t.cc === f.cc && t.sn === f.sn && t.ok && t.sessionIndex !== f.sessionIndex);
  if (otherPeerOk) recoveredViaPeer += 1;
}
const resilienceObserved = fallbacks.length > 0 && (recoveredViaOrigin > 0 || recoveredViaPeer > 0);

// ---- Provenance --------------------------------------------------------------
const mockSessions = sessions.filter((s) => s.provenance !== 'real-device').length;

const report = {
  generatedAt: new Date().toISOString(),
  runs: runs.map((r) => ({ runId: r.runId, scenario: r.scenario, sessions: r.sessions.length, events: r.events.length, file: r.file })),
  sessions: { total: sessions.length, realDevice: sessions.length - mockSessions, mock: mockSessions },
  webrtc: {
    attempts: iceResults.length, success: iceOk.length, failed: iceKo.length,
    successRate: iceResults.length ? iceOk.length / iceResults.length : null,
    avgConnectMs: iceOk.length ? Math.round(avg(iceOk.map((e) => Number(e.ms) || 0))) : null,
    pairDistribution: pairDist,
    dc: { open: dcOpen, close: dcClose, error: dcError },
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
    peerHitRateSegments: segOffload, meshOffloadBytes: byteOffload,
    statsSums: { peerHits: peerHitsStats, originHits: originHitsStats, memoryHits: memHitsStats, idbHits: idbHitsStats, peerBytes: peerBytesStats, originBytes: originBytesStats },
    correlatedTransfers: correlated.length,
  },
  quality: {
    timeouts, hashFailures: hashFails, fallbackTotal: fallbacks.length, fallbackByReason,
    fallbackRate: transfersReq.length ? fallbacks.length / transfersReq.length : null,
    stalls: { count: stalls.length, totalMs: stallDurs.reduce((a, b) => a + b, 0), maxMs: stallDurs.length ? Math.max(...stallDurs) : 0, avgMs: stallDurs.length ? Math.round(avg(stallDurs)) : 0 },
    playErrors: playErrors.length,
    killEvents: kills.length,
  },
  resilience: { fallbackObserved: fallbacks.length, recoveredViaOrigin, recoveredViaPeer, observed: resilienceObserved },
  turn: {
    attempts: iceResults.length, success: iceOk.length, failed: iceKo.length,
    byDevice, byNet, relayPairs, verdict: turnVerdict,
  },
  REAL_P2P_VIDEO: realP2p,
  evidence: correlated.slice(0, 10).map((c) => ({ tid: `${String(c.tid).slice(0, 8)}…`, seg: `${c.cc}:${c.sn}`, bytes: c.bytes, reqMs: c.reqMs, srvMs: c.srvMs, tierPeer: c.tierPeer })),
};

function fmtRate(v) { return v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)} %`; }
function fmtBytes(n) {
  if (!n) return '0 o';
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / 1024 / 1024).toFixed(2)} Mo`;
}

const lines = [];
lines.push(`# Rapport MeshStream — phase canary (test contrôlé)`);
lines.push(``);
lines.push(`Généré : ${report.generatedAt}`);
lines.push(`Runs : ${report.runs.map((r) => `${r.runId}${r.scenario ? ` (scénario ${r.scenario})` : ''} — ${r.sessions} session(s), ${r.events} événement(s)`).join(' · ')}`);
lines.push(`Sessions : ${report.sessions.total} au total (${report.sessions.realDevice} real-device, ${report.sessions.mock} mock) — seules les real-device comptent ci-dessous.`);
lines.push(``);
lines.push(`## REAL_P2P_VIDEO = ${report.REAL_P2P_VIDEO}`);
if (report.REAL_P2P_VIDEO === 'VALIDATED') {
  lines.push(`Preuve : ${correlated.length} transfert(s) corrélé(s) req+srv sur le même tid, octets > 0, même (cc,sn). Exemples :`);
  for (const e of report.evidence) lines.push(`- tid ${e.tid} seg ${e.seg} ${fmtBytes(e.bytes)} (req ${e.reqMs} ms / srv ${e.srvMs} ms) tier peer injecté : ${e.tierPeer ? 'oui' : 'non observé'}`);
} else {
  lines.push(`Aucun transfert corrélé req+srv (même tid, ok des deux côtés, octets > 0) observé sur appareils réels.`);
  lines.push(`Critère : deux appareils physiques doivent réellement échanger un segment via DataChannel — NON DÉMONTRÉ à ce stade. Ne pas élargir le trafic.`);
}
lines.push(``);
lines.push(`## WebRTC (appareils réels uniquement)`);
lines.push(`- Tentatives ICE : ${report.webrtc.attempts} · réussies : ${report.webrtc.success} · échouées : ${report.webrtc.failed} · succès : ${fmtRate(report.webrtc.successRate)}`);
lines.push(`- Durée moyenne de connexion (succès) : ${report.webrtc.avgConnectMs ?? 'n/a'} ms`);
lines.push(`- Paires host/srflx/relay : ${Object.keys(pairDist).length ? Object.entries(pairDist).map(([k, v]) => `${k} ×${v}`).join(', ') : 'aucune paire observée'}`);
lines.push(`- DataChannel : open ×${dcOpen} · close ×${dcClose} · error ×${dcError} · HELLO acceptés ${helloOk}/${hellos.length} · backpressure ×${backpressure}`);
if (report.webrtc.dcStats) lines.push(`- Vie moyenne des liens : ${report.webrtc.dcStats.avgLifetimeMs} ms · émis ${fmtBytes(report.webrtc.dcStats.sentBytes)} · reçus ${fmtBytes(report.webrtc.dcStats.recvBytes)} · timeouts ${report.webrtc.dcStats.timeouts} · aborts ${report.webrtc.dcStats.aborts} · errors ${report.webrtc.dcStats.errors}`);
lines.push(``);
lines.push(`## P2P (appareils réels uniquement)`);
lines.push(`- Transferts demandés (req) : ${report.p2p.transfersRequested} · réussis : ${report.p2p.transfersOk} · servis (srv ok) : ${report.p2p.transfersServed}`);
lines.push(`- Tiers loader : peer ×${report.p2p.tier.peer} · origin ×${report.p2p.tier.origin} · memory ×${report.p2p.tier.memory} · idb ×${report.p2p.tier.idb}`);
lines.push(`- peerSegments / (peerSegments + originSegments) : ${fmtRate(report.p2p.peerHitRateSegments)} (${peerHitsStats}/${peerHitsStats + originHitsStats})`);
lines.push(`- mesh offload peerBytes / (peerBytes + originBytes) : ${fmtRate(report.p2p.meshOffloadBytes)} (${fmtBytes(peerBytesStats)} / ${fmtBytes(peerBytesStats + originBytesStats)})`);
lines.push(`- Transferts corrélés A↔B : ${correlated.length}`);
lines.push(``);
lines.push(`## Qualité`);
lines.push(`- Timeouts : ${timeouts} · hash failures : ${hashFails} · fallbacks : ${fallbacks.length} (${Object.entries(fallbackByReason).map(([k, v]) => `${k} ×${v}`).join(', ') || 'aucun'}) · fallback rate : ${report.quality.fallbackRate === null ? 'n/a' : fmtRate(report.quality.fallbackRate)}`);
lines.push(`- Stalls : ${stalls.length} (total ${report.quality.stalls.totalMs} ms, max ${report.quality.stalls.maxMs} ms, moy ${report.quality.stalls.avgMs} ms) · erreurs lecture : ${playErrors.length}`);
lines.push(`- Événements kill-switch : ${kills.length}`);
lines.push(`- Sessions P2P (peerHits > 0) vs origin-only : ${sessions.filter((s) => s.provenance === 'real-device' && (s.stats?.peerHits ?? 0) > 0).length} vs ${sessions.filter((s) => s.provenance === 'real-device' && (s.stats?.peerHits ?? 0) === 0).length} (comparer stalls/erreurs entre les deux groupes avant toute conclusion)`);
lines.push(``);
lines.push(`## Résilience`);
if (fallbacks.length === 0) lines.push(`- Aucun repli observé (scénario C « disparition du peer » NON TESTÉ).`);
else lines.push(`- Replis : ${fallbacks.length} · reprise via origin observée ×${recoveredViaOrigin} · reprise via un autre peer ×${recoveredViaPeer} · résilience démontrée : ${resilienceObserved ? 'oui (partielle)' : 'non (replis sans reprise tracée)'}`);
lines.push(`- Exigence : peerResult en échec → tier origin sous ≤ timeout (1,5 s défaut), aucun blocage loader, stall > 5 s = STOP.`);
lines.push(``);
lines.push(`## TURN DECISION : ${turnVerdict}`);
lines.push(`- Tentatives ICE : ${iceResults.length} · succès : ${iceOk.length} · échecs : ${iceKo.length}`);
lines.push(`- Par classe d'appareil : ${Object.keys(byDevice).length ? Object.entries(byDevice).map(([k, v]) => `${k} ${v.ok}/${v.attempts}`).join(' · ') : 'n/a'}`);
lines.push(`- Par réseau : ${Object.keys(byNet).length ? Object.entries(byNet).map(([k, v]) => `${k} ${v.ok}/${v.attempts}`).join(' · ') : 'n/a'}`);
lines.push(`- Paires via relay observées : ${relayPairs} · échecs : ${iceKo.length}`);
if (turnVerdict === 'INSUFFICIENT_DATA') lines.push(`- Volume insuffisant (< ${MIN_ICE_FOR_TURN} tentatives) : NE PAS installer TURN. Ne jamais décider TURN sur 1-2 échecs.`);
else lines.push(`- Volume suffisant : statuer sur données (seuil utile ≈ 60-70 % jugé sur données réelles, cf. runbook).`);
lines.push(``);
lines.push(`## Statut de preuve (ne jamais mélanger)`);
lines.push(`- PROUVÉ EN PRODUCTION : signaling, auth, kill-switch, polling, WebSocket (batterie §6 edge + runbook étape 6 — hors captures, voir docs/operations/meshstream-step6-validation.md).`);
lines.push(`- PROUVÉ PAR MOCK : PeerLink, DataChannel, scoring, loader (tests unitaires : packages/mesh + workers — ${transfersReq.length ? 'complétés par' : 'sans'} observations réelles ci-dessus).`);
lines.push(`- PROUVÉ SUR APPAREILS RÉELS : ${correlated.length ? `${correlated.length} transfert(s) corrélé(s), ICE ${iceOk.length}/${iceResults.length}, offload ${fmtRate(byteOffload)}` : 'RIEN pour l\'instant (aucune corrélation tid req+srv)'} — seul ce qui est ci-dessus compte.`);
lines.push(`- NON TESTÉ : ${[
  fallbacks.length ? null : 'résilience disparition du peer',
  stalls.length ? null : 'stalls en conditions réelles',
  pairs.length < 3 ? 'matrice CGNAT multi-réseaux' : null,
  'Android/WebView/Android TV (sauf sessions deviceClass correspondantes)',
  turnVerdict === 'INSUFFICIENT_DATA' ? 'décision TURN (données insuffisantes)' : null,
].filter(Boolean).join(' · ') || 'voir sections ci-dessus'}.`);
lines.push(``);
lines.push(`## STOP CONDITIONS (rappel opérateur)`);
lines.push(`kill-switch + canary OFF immédiats si : stall > 5 s · erreurs lecture en hausse · fallback origin cassé · boucle WebRTC · CPU/réseau/mémoire anormaux · crash · P2P non désactivable · fuite token/IP/URL dans la télémétrie. Conserver les logs, générer ce rapport, ne pas élargir.`);

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
