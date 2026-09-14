// Configuration du mesh : valeurs par défaut de meshConfigSchema (§17 de
// docs/architecture/meshstream.md) + overrides env bornés. Aucun nombre
// magique ailleurs dans le worker : tout part d'ici, tout est validé par le
// contrat Zod (qui porte déjà les min/max — impossible de pousser maxPeers=500).
import {
  meshConfigSchema,
  MESH_PROTOCOL_VERSION,
  MESH_MIN_PROTOCOL_VERSION_DEFAULT,
  MESH_DEFAULT_MAX_PEERS,
  MESH_HARD_MAX_PEERS,
  MESH_MAX_WINDOW_SEGMENTS,
  MESH_MAX_CHUNK_BYTES,
  MESH_MAX_CANDIDATES,
  MESH_SWARM_SOFT_LIMIT,
} from "@mbolo/contracts";

const DEFAULTS = {
  p2pEnabled: true, // override par MESH_KILL_SWITCH="1" (kill switch opérationnel sans redéploiement)
  maxPeers: MESH_DEFAULT_MAX_PEERS,
  peerTimeoutMs: 1500,
  bufferCriticalSec: 12,
  liveEdgeSafetySegments: 2,
  heartbeatMs: 30_000,
  statsIntervalMs: 120_000,
  pollIntervalMs: 4000,
  candidateSample: 8,
  windowSize: MESH_MAX_WINDOW_SEGMENTS,
  chunkBytes: MESH_MAX_CHUNK_BYTES,
  protocolVersion: MESH_PROTOCOL_VERSION,
  minProtocolVersion: MESH_MIN_PROTOCOL_VERSION_DEFAULT,
};

function intOverride(env, name, min, max) {
  const raw = Number.parseInt(String(env?.[name] ?? ""), 10);
  if (!Number.isFinite(raw)) return undefined;
  return Math.min(Math.max(raw, min), max); // borné DUR : l'env ne peut pas sortir du contrat
}

// Le contrat Zod sert de GARDE FINALE : toute dérive (clé mal orthographiée,
// valeur hors plage) échoue au parse plutôt que de se propager.
const SAFE_FALLBACK = { ...DEFAULTS, p2pEnabled: false };

export function meshConfigFromEnv(env) {
  const cfg = {
    ...DEFAULTS,
    p2pEnabled: String(env?.MESH_KILL_SWITCH ?? "").trim() !== "1",
    maxPeers: intOverride(env, "MESH_MAX_PEERS", 0, MESH_HARD_MAX_PEERS) ?? DEFAULTS.maxPeers,
    peerTimeoutMs: intOverride(env, "MESH_PEER_TIMEOUT_MS", 300, 5000) ?? DEFAULTS.peerTimeoutMs,
    heartbeatMs: intOverride(env, "MESH_HEARTBEAT_MS", 10_000, 120_000) ?? DEFAULTS.heartbeatMs,
    pollIntervalMs: intOverride(env, "MESH_POLL_INTERVAL_MS", 2000, 30_000) ?? DEFAULTS.pollIntervalMs,
    candidateSample: intOverride(env, "MESH_CANDIDATE_SAMPLE", 1, MESH_MAX_CANDIDATES) ?? DEFAULTS.candidateSample,
  };
  const parsed = meshConfigSchema.safeParse(cfg);
  return parsed.success ? cfg : SAFE_FALLBACK; // config cassée = P2P coupé, streaming intact
}

export const HEARTBEAT_TTL_MS = 120_000; // 4 battements manqués ≈ pair mort (spéc. §9 : alarme 30 s)
export const SWEEP_INTERVAL_MS = 30_000; // cadence de l'alarme DO de purge
export const SOFT_LIMIT = MESH_SWARM_SOFT_LIMIT;
export const POLL_QUEUE_MAX = 64; // file descendante par pair en mode polling
export const MSG_RATE_LIMIT = 10; // messages applicatifs / s / pair (JOIN/HEARTBEAT/…)
// Tempête de JOIN : bornée structurellement — un re-JOIN du même pid REMPLACE
// la session (aucun empilement), et chaque connexion exige un jeton HMAC frais.
