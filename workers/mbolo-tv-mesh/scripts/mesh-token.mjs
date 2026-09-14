#!/usr/bin/env node
// ============================================================================
// scripts/mesh-token.mjs — Fabrique des meshTokens de TEST pour la batterie
// d'authentification §6 (et le test manuel sur appareils). Usage :
//
//   node scripts/mesh-token.mjs --secret "$MESH_URL_SECRET" --sid <32hex> \
//        [--pid <22car>] [--ttl <ms>] [--expired] [--swarm <autre-sid>]
//
// Sortie : { pid, sid, token, expiresAt } en JSON. Le jeton est signé avec le
// MÊME HMAC que l'API (mesh-token.ts des contrats) — donc reconnu par le worker
// réel SANS passer par l'API. `--expired` produit un jeton déjà périmé,
// `--pid-bad` un peerId malformé, pour tester les refus (§6 B/D).
//
// SÉCURITÉ : le secret est requis explicitement (jamais de secret codé en dur).
// Ce script ne parle à AUCUN service ; il ne fait que signer localement.
// ============================================================================
import { parseArgs } from 'node:util';
import { computeMeshSwarmId, createMeshToken, deriveMeshDid, newMeshPeerId, meshPeerIdSchema } from '@mbolo/contracts';

const { values: args } = parseArgs({
  options: {
    secret: { type: 'string' }, sid: { type: 'string' }, pid: { type: 'string' },
    ttl: { type: 'string' }, expired: { type: 'boolean', default: false },
    'pid-bad': { type: 'boolean', default: false },
    // Pour générer un sid réel à partir des ids métier (pratique pour le test) :
    source: { type: 'string' }, channel: { type: 'string' }, variant: { type: 'string' },
    eco: { type: 'string', default: 'hd' },
  },
});

const secret = args.secret ?? process.env.MESH_URL_SECRET;
if (!secret) { console.error('secret requis (--secret ou MESH_URL_SECRET)'); process.exit(2); }

let sid = args.sid;
if (!sid && args.source && args.channel && args.variant) {
  sid = await computeMeshSwarmId(secret, { sourceId: args.source, channelId: args.channel, variantId: args.variant, ecoFlag: args.eco === 'eco' ? 'eco' : 'hd' });
}
if (!sid || !/^[0-9a-f]{32}$/.test(sid)) { console.error('sid invalide (32 hex) — passez --sid ou --source/--channel/--variant'); process.exit(2); }

const pid = args['pid-bad'] ? 'pas-un-peerid' : (args.pid ?? newMeshPeerId());
const now = Date.now();
const ttlMs = Number(args.ttl ?? 3_600_000);
const iat = args.expired ? now - ttlMs - 10_000 : now;
const exp = args.expired ? now - 5_000 : now + ttlMs;
const did = await deriveMeshDid(secret, 'devicehash-de-test', new Date().toISOString().slice(0, 10));

try {
  const token = await createMeshToken(secret, { v: 1, pid, sid, did, iat, exp });
  console.log(JSON.stringify({ pidValid: meshPeerIdSchema.safeParse(pid).success, pid, sid, token, expiresAt: exp }));
} catch (error) {
  // pid-bad : le schéma strict du contrat refuse à l'émission (normal). On
  // produit quand même un jeton FORCÉ pour tester le refus CÔTÉ WORKER.
  if (args['pid-bad']) {
    const body = btoa(JSON.stringify({ v: 1, pid, sid, did, iat, exp })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    console.log(JSON.stringify({ pid, sid, token: `${body}.forced`, forced: true, error: String(error?.message ?? error) }));
  } else { console.error(String(error?.message ?? error)); process.exit(1); }
}
