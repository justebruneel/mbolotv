#!/usr/bin/env node
// ============================================================================
// scripts/mesh-remote-check.mjs — Batterie §6/§9 EN LIGNE contre un worker
// mesh DÉJÀ déployé (mode polling HTTP : mêmes enveloppes et MÊME porte
// d'authentification que le WebSocket). Usage :
//
//   MESH_URL_SECRET=... node scripts/mesh-remote-check.mjs https://<worker-url>
//
// Preuves produites (sans aucun accès aux fournisseurs, sans vidéo) :
//   A JOIN accepté + JOIN_ACCEPTED avec cfg
//   E cap=off JAMAIS publié comme candidat (règle serveur)
//   renditions divergentes jamais candidates
//   usurpation d'identité (id ≠ porteur du jeton) refusée
//   G kill-switch : avec MESH_KILL_SWITCH="1" côté serveur, JOIN_ACCEPTED
//     renvoie cfg.p2pEnabled:false (refus doux — le test G complet se fait en
//     basculant le secret puis en rejouant ce script)
// Sortie : une ligne [mesh-test] par preuve + récap. Zéro secret imprimé.
// ============================================================================
import { MESH_PROTOCOL_VERSION, createMeshToken, computeMeshSwarmId, deriveMeshDid, newMeshPeerId } from '@mbolo/contracts';

const BASE = (process.argv[2] ?? '').replace(/\/+$/, '');
const SECRET = process.env.MESH_URL_SECRET ?? process.argv[3];
if (!BASE || !SECRET) { console.error('usage: MESH_URL_SECRET=... node scripts/mesh-remote-check.mjs <base-url>'); process.exit(2); }
const KILL = process.env.EXPECT_KILLED === '1';

const sid = await computeMeshSwarmId(SECRET, { sourceId: 'test-source', channelId: 'test-channel', variantId: 'test-variant', ecoFlag: 'eco' });
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`[mesh-test] ${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function mint(ttlMs = 10 * 60_000) {
  const pid = newMeshPeerId();
  const now = Date.now();
  const did = await deriveMeshDid(SECRET, 'devicehash-check', new Date().toISOString().slice(0, 10));
  return { pid, token: await createMeshToken(SECRET, { v: 1, pid, sid, did, iat: now, exp: now + ttlMs }) };
}

async function send(peer, envelope) {
  const r = await fetch(`${BASE}/mesh/send?token=${encodeURIComponent(peer.token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) });
  if (!r.ok) throw new Error(`send ${r.status}`);
}
async function pollAll(peer, cursor = 0) {
  const r = await fetch(`${BASE}/mesh/poll?token=${encodeURIComponent(peer.token)}&cursor=${cursor}`);
  const body = await r.json();
  return { cursor: body.cursor ?? cursor, events: (body.events ?? []).map((e) => JSON.parse(e)) };
}
const env = (peer, t, d) => ({ v: MESH_PROTOCOL_VERSION, t, sid, id: peer.pid, seq: Math.floor(Math.random() * 1e6) + 1, ts: Date.now(), d });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- A. JOIN accepté -------------------------------------------------------
const a = await mint(); const b = await mint(); const off = await mint();
await send(a, env(a, 'JOIN_SWARM', { proto: 1, cap: 'normal', net: 'wifi', rid: 'aaaaaaaa' }));
await sleep(300);
let pa = await pollAll(a);
const accepted = pa.events.find((e) => e.t === 'JOIN_ACCEPTED');
check('A. JOIN_SWARM → JOIN_ACCEPTED + cfg', Boolean(accepted), accepted ? `peers=${accepted.d.peers.length}` : 'aucun événement');
check('G. kill-switch attendu', KILL ? accepted?.d.cfg.p2pEnabled === false : accepted?.d.cfg.p2pEnabled !== false, `p2pEnabled=${accepted?.d.cfg.p2pEnabled} (EXPECT_KILLED=${KILL ? '1' : '0'})`);

// --- fenêtre annoncée par A, puis B rejoint : B doit voir A -----------------
await send(a, env(a, 'HEARTBEAT', { cap: 'normal', win: { cc: 0, first: 10, last: 14 }, rid: 'aaaaaaaa' }));
await send(b, env(b, 'JOIN_SWARM', { proto: 1, cap: 'normal', net: 'wifi', rid: 'aaaaaaaa' }));
await send(off, env(off, 'JOIN_SWARM', { proto: 1, cap: 'off', net: 'wifi', rid: 'aaaaaaaa' }));
await send(off, env(off, 'HEARTBEAT', { cap: 'off', win: { cc: 0, first: 10, last: 14 }, rid: 'aaaaaaaa' })); // le serveur DOIT ignorer la fenêtre
await sleep(400);
const pb = await pollAll(b);
const joinB = pb.events.find((e) => e.t === 'JOIN_ACCEPTED');
const listed = (joinB?.d.peers ?? []).map((p) => p.id);
check('B candidat voit A', listed.includes(a.pid));
check('E cap=off jamais candidat (même avec fenêtre auto-déclarée)', !listed.includes(off.pid));

// --- renditions divergentes -------------------------------------------------
const z = await mint();
await send(z, env(z, 'JOIN_SWARM', { proto: 1, cap: 'normal', net: 'wifi', rid: 'bbbbbbbb' }));
await sleep(250);
const pz = await pollAll(z);
const joinZ = pz.events.find((e) => e.t === 'JOIN_ACCEPTED');
check('rid divergent : A (rid aaaaaaaa) non candidat', !(joinZ?.d.peers ?? []).some((p) => p.id === a.pid && p.rid && p.rid !== 'bbbbbbbb'));

// Le DO fixe l'identité sur le PORTEUR du jeton : msg.id (A) ≠ pid porteur (B)
// → INVALID_MESSAGE renvoyé à B, et A ne reçoit strictement RIEN de neuf.
const aBase = await pollAll(a, pa.cursor); // vide la file de A avant l'attaque
const bCursorBefore = (await pollAll(b, pb.cursor)).cursor;
await send(b, env(a, 'HEARTBEAT', { cap: 'normal' }));
await sleep(300);
const pa3 = await pollAll(a, aBase.cursor);
const pb3 = await pollAll(b, bCursorBefore);
check('usurpation : ERROR{INVALID_MESSAGE} renvoyée AU PORTEUR (B)', pb3.events.some((e) => e.t === 'ERROR' && e.d.code === 'INVALID_MESSAGE' && e.id === b.pid));
check('usurpation : rien de neuf pour A', pa3.events.length === 0, `events=${pa3.events.length}`);

const passed = results.filter((r) => r.pass).length;
console.log(`\n[mesh-test] RÉSUMÉ §6/§9 en ligne : ${passed}/${results.length} preuves OK`);
process.exit(passed === results.length ? 0 : 1);
