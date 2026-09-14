#!/usr/bin/env node
// ============================================================================
// mesh-capture.mjs — Normalisation des dumps de test MeshStream (phase canary).
//
// MODE D'EMPLOI (responsable du test) :
//   node scripts/mesh-capture.mjs ./device-a.json ./device-b.json \
//     --run run-2026-09-14-a-b --scenario A --note "wifi maison, 2 testeurs"
//   # Forme courte équivalente (run déduit de la date, sortie par défaut) :
//   node scripts/mesh-capture.mjs ./device-a.json ./device-b.json
//
// Chaque dump est un export window.__meshTest.dump() d'UN appareil physique
// (ou window.__meshTest.export()). Le script :
//   1. valide le format (JSON objet, événements bornés) ;
//   2. vérifie la provenance (real-device | mock, promotion mock→real INTERDITE) ;
//   3. détecte les fuites (token, URL, IP, deviceId, cookie…) → REJET du fichier ;
//   4. normalise les timestamps (at/rel complétés, runRel = at - t0 du run) ;
//   5. associe les événements (sessionIndex par appareil, runId commun) ;
//   6. regroupe en mesh-test-runs/<run-id>.json pour scripts/mesh-report.mjs
//      (corrélation des tid + métriques — voir ce script).
//
// Ce script NE COLLECTE RIEN tout seul : il valide + normalise des fichiers
// locaux. Aucun endpoint réseau, aucune base, aucun tracking (choix assumé de
// l'étape canary : préférer l'export JSON local à un nouveau stockage serveur).
// Les horloges des appareils ne sont PAS synchronisées : runRel n'est qu'un
// repère d'ordre grossier — la corrélation A↔B se fait par `tid` (nonce
// partagé), jamais par l'horloge.
//
// GARDE-FOUS :
//   - taille max 1 Mo par dump, 10 000 événements max ;
//   - AUCUNE donnée personnelle acceptée → fichier REJETÉ, jamais « nettoyé » ;
//   - la provenance est PRÉSERVÉE par session et ne peut jamais être promue.
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const MAX_FILE_BYTES = 1_000_000;
const MAX_EVENTS = 10_000;
const FORBIDDEN_KEY_RE = /token|deviceid|devicehash|email|cookie|grant|secret|password|authorization|set-cookie|x-sig|x-exp|locator|provider|iptv|xtream|stalker/i;
const FORBIDDEN_VALUE_RE = /https?:\/\/|wss?:\/\/|x-sig|x-exp|meshToken|DeviceGrant/i;
const CANDIDATE_TYPES = new Set(['host', 'srflx', 'relay', 'prflx', 'unknown']);
const RUN_RE = /^[a-z0-9][a-z0-9-_]{1,64}$/i;
// Scénarios : A 2 appareils même Wi-Fi · B chaîne 3 appareils A→B→C ·
// C disparition du peer · D kill-switch live · E réseaux différents ·
// F arrière-plan · G Android/WebView · H Android TV.
const SCENARIOS = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
const PROVENANCES = new Set(['real-device', 'mock']);

function fail(msg) { console.error(`mesh-capture: ERREUR: ${msg}`); process.exit(1); }
function warn(msg) { console.error(`mesh-capture: AVERTISSEMENT: ${msg}`); }

function findLeak(node, path = '$') {
  if (typeof node === 'string') {
    if (FORBIDDEN_VALUE_RE.test(node)) return `valeur suspecte en ${path}`;
    return null;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const hit = findLeak(node[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_KEY_RE.test(k) || k.toLowerCase() === 'url' || k.toLowerCase() === 'did') return `clé interdite ${path}.${k}`;
      const hit = findLeak(v, path ? `${path}.${k}` : k);
      if (hit) return hit;
      if ((k === 'local' || k === 'remote') && typeof v === 'string' && !CANDIDATE_TYPES.has(v)) {
        return `type de candidat inattendu en ${path}.${k} (attendu host|srflx|relay)`;
      }
      if (typeof v === 'string' && /^\d{1,3}(\.\d{1,3}){3}([:/]|$)/.test(v)) return `adresse IPv4 possible en ${path}.${k}`;
    }
  }
  return null;
}

function parseArgs(argv) {
  const out = { in: [], out: null, run: null, scenario: null, note: '', provenance: null, checkOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--in') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) out.in.push(argv[++i]); }
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--run') out.run = argv[++i];
    else if (a === '--scenario') out.scenario = argv[++i];
    else if (a === '--note') out.note = argv[++i] ?? '';
    else if (a === '--provenance') out.provenance = argv[++i];
    else if (a === '--check-only') out.checkOnly = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/mesh-capture.mjs ./device-a.json [./device-b.json ...] [--run <run-id>] [--out mesh-test-runs/<run-id>.json] [--scenario <A-H>] [--note "..."] [--provenance real-device|mock] [--check-only]
  (l'ancienne forme --in f1 f2 reste acceptée ; --run/--out ont des défauts)

Scénarios : A 2 appareils même Wi-Fi · B chaîne A→B→C · C disparition du peer ·
D kill-switch live · E réseaux différents · F arrière-plan · G Android/WebView · H Android TV.

Chaque appareil annote de préférence son run en console AVANT le test :
  window.__meshTest.setRunId('<run-id>')   // repris tel quel dans le dump.`);
      process.exit(0);
    } else if (a.startsWith('--')) fail(`argument inconnu: ${a}`);
    else out.in.push(a); // argument positionnel = fichier dump
  }
  return out;
}

function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; }
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; }

const warnedTypes = new Set();
function normalizeEvents(rawEvents, fileLabel) {
  const events = Array.isArray(rawEvents) ? rawEvents : [];
  if (events.length > MAX_EVENTS) fail(`${fileLabel}: ${events.length} événements > ${MAX_EVENTS}`);
  let normalized = 0;
  // t0 de session = premier `at` numérique (repère d'ordre local à l'appareil).
  let firstAt = null;
  for (const e of events) {
    const at = numOrNull(e?.at);
    if (at !== null && (firstAt === null || at < firstAt)) firstAt = at;
  }
  const out = events.map((e, i) => {
    if (!e || typeof e !== 'object') fail(`${fileLabel}: événement #${i} invalide (objet attendu)`);
    if (typeof e.t !== 'string' && !warnedTypes.has('(sans-t)')) { warnedTypes.add('(sans-t)'); warn(`${fileLabel}: événement sans champ 't' (conservé, ignoré par le rapport)`); }
    if (typeof e.t === 'string' && !KNOWN_TYPES.has(e.t) && !warnedTypes.has(e.t)) {
      warnedTypes.add(e.t);
      warn(`${fileLabel}: type d'événement inconnu '${e.t}' (conservé pour compatibilité future, ignoré par le rapport)`);
    }
    const at = numOrNull(e.at);
    let rel = numOrNull(e.rel);
    if (rel === null) {
      rel = at !== null && firstAt !== null ? Math.max(0, at - firstAt) : 0;
      normalized += 1;
    }
    return { ...e, at, rel };
  });
  return { events: out, normalized };
}

// Types d'événements connus (trace.ts) — un type inconnu = avertissement, jamais rejet.
const KNOWN_TYPES = new Set(['session', 'ice', 'iceResult', 'candidatePair', 'dc', 'dcStats', 'backpressure', 'hello', 'selected', 'skipped', 'peerResult', 'transfer', 'tier', 'fallback', 'stall', 'playError', 'visibility', 'kill', 'capacity', 'error']);

function defaultRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `run-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function normalizeDump(raw, index, fileLabel) {
  if (!raw || typeof raw !== 'object') fail(`dump #${index} (${fileLabel}): JSON racine objet attendu`);
  const leak = findLeak(raw);
  if (leak) fail(`dump #${index} (${fileLabel}): DONNÉE INTERDITE détectée (${leak}) — fichier rejeté, voir docs/operations/meshstream-step6-human-test.md § export`);
  const provenance = raw.provenance ?? 'real-device';
  if (!PROVENANCES.has(provenance)) fail(`dump #${index} (${fileLabel}): provenance invalide (${provenance}) — attendu real-device|mock`);
  const runId = raw.runId == null ? null : String(raw.runId).slice(0, 64);
  if (runId !== null && !RUN_RE.test(runId)) fail(`dump #${index} (${fileLabel}): runId invalide (${runId})`);
  const { events, normalized } = normalizeEvents(raw.events, fileLabel);
  return {
    sessionIndex: index,
    runId,
    provenance,
    deviceClass: typeof raw.deviceClass === 'string' ? raw.deviceClass.slice(0, 16) : 'unknown',
    swarm: typeof raw.swarm === 'string' ? raw.swarm.slice(0, 16) : (typeof raw.sid8 === 'string' ? raw.sid8.slice(0, 16) : 'unknown'),
    peer: typeof raw.peer === 'string' ? String(raw.peer).slice(0, 32) : null,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt.slice(0, 32) : null,
    stats: {
      meshAttempts: num(raw.meshAttempts), memoryHits: num(raw.memoryHits),
      persistentCacheHits: num(raw.persistentCacheHits), peerHits: num(raw.peerHits),
      originHits: num(raw.originHits), peerFailures: num(raw.peerFailures),
      peerTimeouts: num(raw.peerTimeouts), peerHashFailures: num(raw.peerHashFailures),
      webrtcSuccess: num(raw.webrtcSuccess), webrtcFailure: num(raw.webrtcFailure),
      bytesFromPeers: num(raw.bytesFromPeers), bytesFromOrigin: num(raw.bytesFromOrigin),
      bytesFromMemory: num(raw.bytesFromMemory), bytesFromIndexedDB: num(raw.bytesFromIndexedDB),
      bytesServedToPeers: num(raw.bytesServedToPeers), peers: num(raw.peers),
      peerHitRate: Number.isFinite(Number(raw.peerHitRate)) ? Number(raw.peerHitRate) : 0,
      meshOffload: Number.isFinite(Number(raw.meshOffload)) ? Number(raw.meshOffload) : 0,
    },
    dropped: num(raw.dropped),
    normalizedTimestamps: normalized,
    eventCount: events.length,
    events,
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.in.length === 0) fail('aucun fichier dump (exports window.__meshTest.dump() — voir --help)');
if (args.run !== null && !RUN_RE.test(args.run)) fail('--run invalide (alphanum + - _ , 2-64 car.)');
if (args.scenario && !SCENARIOS.has(args.scenario)) fail(`--scenario invalide (${args.scenario}), attendu ${[...SCENARIOS].join('|')}`);
if (args.provenance && !PROVENANCES.has(args.provenance)) fail(`--provenance invalide (${args.provenance})`);

const sessions = [];
const mergedEvents = [];
args.in.forEach((file, i) => {
  const path = resolve(file);
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) { fail(`lecture impossible de ${file}: ${e.message}`); }
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) fail(`${file}: ${(Buffer.byteLength(text, 'utf8') / 1024).toFixed(0)} Ko > 1 Mo — dump trop gros (collecteur borné à 2000 événements ?)`);
  let raw;
  try { raw = JSON.parse(text); }
  catch { fail(`${file}: JSON invalide`); }
  // Un fichier run déjà normalisé (relance) est accepté tel quel : les
  // événements vivent au top-level `events`, regroupés ici par sessionIndex
  // (les sessions normalisées ne portent plus leur tableau `events`).
  if (raw && raw.v === 1 && Array.isArray(raw.sessions)) {
    const byIdx = new Map();
    for (const e of raw.events ?? []) {
      const k = Number(e?.sessionIndex);
      if (!Number.isInteger(k)) continue;
      if (!byIdx.has(k)) byIdx.set(k, []);
      const { sessionIndex: _old, runRel: _runRel, ...rest } = e;
      byIdx.get(k).push(rest); // runRel recalculé plus bas sur l'ensemble
    }
    raw.sessions.forEach((s) => {
      const idx = sessions.length;
      const se = byIdx.has(s.sessionIndex) ? byIdx.get(s.sessionIndex) : (s.events ?? []);
      const { events: _se, ...sMeta } = s;
      const norm = normalizeEvents(se, `${file}#${s.sessionIndex ?? '?'}`);
      sessions.push({ runId: typeof s.runId === 'string' ? s.runId : (typeof raw.runId === 'string' ? raw.runId : null), ...sMeta, sessionIndex: idx, sourceFile: file, normalizedTimestamps: (s.normalizedTimestamps ?? 0) + norm.normalized, eventCount: norm.events.length });
      for (const e of norm.events) mergedEvents.push({ sessionIndex: idx, ...e });
    });
    return;
  }
  const session = normalizeDump(raw, sessions.length, file);
  if (args.provenance) {
    // Dégradation autorisée (real-device → mock si doute), JAMAIS de promotion.
    if (session.provenance === 'mock' && args.provenance === 'real-device') {
      fail(`dump #${i} (${file}): provenance mock — promotion vers real-device INTERDITE`);
    }
    session.provenance = args.provenance === 'mock' ? 'mock' : session.provenance;
  }
  session.sourceFile = file;
  sessions.push(session);
  for (const e of session.events) mergedEvents.push({ sessionIndex: session.sessionIndex, ...e });
});

if (mergedEvents.length > MAX_EVENTS * sessions.length) warn('volume d\'événements élevé — le rapport restera lisible mais vérifiez le collecteur (maxEvents 2000/appareil)');

// runId : les dumps annotés (setRunId) priment ; --run explicite sinon ;
// défaut = run-<date-heure>. Désaccord entre appareils = avertissement fort
// (possible mélange de deux sessions de test).
const dumpRunIds = [...new Set(sessions.map((s) => s.runId).filter(Boolean))];
let runId = args.run;
if (!runId && dumpRunIds.length === 1) runId = dumpRunIds[0];
if (!runId) {
  if (dumpRunIds.length > 1) fail(`runIds contradictoires entre dumps (${dumpRunIds.join(', ')}) — précisez --run`);
  runId = defaultRunId();
  warn(`aucun --run : runId par défaut ${runId} (recommandé : window.__meshTest.setRunId() sur chaque appareil AVANT le test)`);
}
if (dumpRunIds.length > 0 && dumpRunIds.some((id) => id !== runId)) {
  warn(`désaccord runId : dumps annotés [${dumpRunIds.join(', ')}] mais run=${runId} — vérifiez qu'il s'agit bien de la même session de test`);
}

// runRel : repère d'ordre inter-appareils (horloges NON synchronisées —
// indicatif seulement ; la corrélation A↔B se fait par tid, jamais par l'horloge).
let runT0 = null;
for (const e of mergedEvents) {
  if (typeof e.at === 'number' && (runT0 === null || e.at < runT0)) runT0 = e.at;
}
for (const e of mergedEvents) e.runRel = (typeof e.at === 'number' && runT0 !== null) ? Math.max(0, e.at - runT0) : null;

const run = {
  v: 1,
  runId,
  scenario: args.scenario ?? null,
  createdAt: new Date().toISOString(),
  note: String(args.note ?? '').slice(0, 500),
  sessions: sessions.map(({ events, ...s }) => s),
  events: mergedEvents,
  eventCount: mergedEvents.length,
  sessionCount: sessions.length,
};

const outLeak = findLeak(run);
if (outLeak) fail(`fichier normalisé: DONNÉE INTERDITE (${outLeak}) — abandon`);

if (args.checkOnly) {
  console.log(JSON.stringify({ ok: true, runId: run.runId, sessions: run.sessionCount, events: run.eventCount }, null, 2));
  process.exit(0);
}

const outPath = resolve(args.out ?? `mesh-test-runs/${run.runId}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(run, null, 2)}\n`);
console.log(`mesh-capture: OK — run ${run.runId} : ${run.sessionCount} session(s), ${run.eventCount} événement(s) → ${outPath}`);
for (const s of sessions) {
  console.log(`  session #${s.sessionIndex} [${s.provenance}/${s.deviceClass}] swarm=${s.swarm} peer=${s.peer ?? '?'} events=${s.eventCount} peerHits=${s.stats.peerHits} originHits=${s.stats.originHits}${s.normalizedTimestamps ? ` (timestamps normalisés: ${s.normalizedTimestamps})` : ''}`);
}
