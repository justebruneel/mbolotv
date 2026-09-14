#!/usr/bin/env node
// ============================================================================
// mesh-capture.mjs — Normalisation des dumps de test MeshStream (phase canary).
//
// MODE D'EMPLOI (testeur) :
//   1. Sur chaque appareil : ouvrir l'app canary, lancer la chaîne de test,
//      attendre la fin du scénario, puis console devtools :
//        copy(JSON.stringify(window.__meshTest.dump()))
//      (ou cliquer le bouton exporté par window.__meshTest.export())
//   2. Coller chaque dump dans un fichier raw-*.json.
//   3. Responsable du test :
//        node scripts/mesh-capture.mjs --in raw-a.json raw-b.json \
//          --out mesh-test-runs/run-2026-09-14-a-b.json \
//          --run run-2026-09-14-a-b --scenario A --note "wifi maison, 2 testeurs"
//
// Ce script NE COLLECTE RIEN tout seul : il valide + normalise des fichiers
// locaux. Aucun endpoint réseau, aucune base, aucun tracking (choix assumé de
// l'étape canary : préférer l'export JSON local à un nouveau stockage serveur).
//
// GARDE-FOUS :
//   - taille max 1 Mo par dump, 10 000 événements max ;
//   - AUCUNE donnée personnelle acceptée (token, URL, IP, deviceId, cookie…)
//     → le fichier est REJETÉ avec la raison, jamais « nettoyé » en silence ;
//   - la provenance (real-device | mock) est PRÉSERVÉE par session et ne peut
//     jamais être promue mock → real-device (le rapport refuserait sinon de
//     conclure REAL_P2P_VIDEO = VALIDATED).
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const MAX_FILE_BYTES = 1_000_000;
const MAX_EVENTS = 10_000;
const FORBIDDEN_KEY_RE = /token|deviceid|devicehash|email|cookie|grant|secret|password|authorization|set-cookie|x-sig|x-exp|locator|provider|iptv|xtream|stalker/i;
const FORBIDDEN_VALUE_RE = /https?:\/\/|wss?:\/\/|x-sig|x-exp|meshToken|DeviceGrant/i;
const CANDIDATE_TYPES = new Set(['host', 'srflx', 'relay', 'prflx', 'unknown']);
const SCENARIOS = new Set(['A', 'B', 'C', 'D', 'E', 'F']);
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
      if ((path.endsWith('.local') || path.endsWith('.remote')) && typeof v === 'string' && !CANDIDATE_TYPES.has(v)) {
        // Vérifié au niveau parent ; ici on ne fait que propager.
      }
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
  node scripts/mesh-capture.mjs --in raw-a.json [raw-b.json ...] --out mesh-test-runs/<run-id>.json --run <run-id> --scenario <A|B|C|D|E|F> [--note "..."] [--provenance real-device|mock] [--check-only]

Scénarios : A même Wi-Fi · B réseaux différents · C disparition du peer ·
D arrière-plan · E Android/WebView · F Android TV.`);
      process.exit(0);
    } else fail(`argument inconnu: ${a}`);
  }
  return out;
}

function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; }

function normalizeDump(raw, index) {
  if (!raw || typeof raw !== 'object') fail(`dump #${index}: JSON racine objet attendu`);
  const events = Array.isArray(raw.events) ? raw.events : [];
  if (events.length > MAX_EVENTS) fail(`dump #${index}: ${events.length} événements > ${MAX_EVENTS}`);
  const leak = findLeak(raw);
  if (leak) fail(`dump #${index}: DONNÉE INTERDITE détectée (${leak}) — fichier rejeté, voir docs/operations/meshstream-step6-human-test.md § export`);
  const provenance = raw.provenance ?? 'real-device';
  if (!PROVENANCES.has(provenance)) fail(`dump #${index}: provenance invalide (${provenance})`);
  return {
    sessionIndex: index,
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
    eventCount: events.length,
    events,
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.in.length === 0) fail('aucun fichier --in (dumps window.__meshTest.dump())');
if (!args.run) fail('--run <run-id> requis (ex. run-2026-09-14-a-b)');
if (!/^[a-z0-9][a-z0-9-_]{1,64}$/i.test(args.run)) fail('--run invalide (alphanum + - _ , 2-64 car.)');
if (args.scenario && !SCENARIOS.has(args.scenario)) fail(`--scenario invalide (${args.scenario}), attendu A|B|C|D|E|F`);
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
  // Un fichier run déjà normalisé (relance) est accepté tel quel par session.
  if (raw && raw.v === 1 && Array.isArray(raw.sessions)) {
    raw.sessions.forEach((s) => {
      const idx = sessions.length;
      sessions.push({ ...s, sessionIndex: idx, sourceFile: file });
      for (const e of s.events ?? []) mergedEvents.push({ sessionIndex: idx, ...e });
    });
    return;
  }
  const session = normalizeDump(raw, sessions.length);
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

const run = {
  v: 1,
  runId: args.run,
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
console.log(`mesh-capture: OK — ${run.sessionCount} session(s), ${run.eventCount} événement(s) → ${outPath}`);
for (const s of sessions) {
  console.log(`  session #${s.sessionIndex} [${s.provenance}/${s.deviceClass}] swarm=${s.swarm} peer=${s.peer ?? '?'} events=${s.eventCount} peerHits=${s.stats.peerHits} originHits=${s.stats.originHits}`);
}
