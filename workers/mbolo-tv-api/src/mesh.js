// ============================================================================
// MeshStream — émission des jetons côté API (ADR-0004, étape 3).
//
// Séparation stricte (spec §4) : l'API EST la porte d'autorisation (DeviceGrant
// déjà vérifié par respondWithPlay AVANT cet appel) ; elle signe un jeton qui
// dit « ce peer, ce swarm, jusqu'ici ». Le worker mesh vérifie le HMAC et ne
// pose AUCUNE question à Postgres.
//
// Le HMAC, le format de jeton et le calcul du swarmId vivent dans
// @mbolo/contracts (mesh-token.ts) : l'API et le worker mesh partagent la même
// implémentation — aucune dérive possible entre l'émission et la vérification.
//
// Flags (aucune migration Prisma, tout en env) :
//   MESH_ENABLED="1"          → interrupteur GLOBAL d'émission (absent =
//                               réponse /play BYTE-PER-BYTE identique à avant)
//   MESH_URL_SECRET           → secret HMAC partagé avec le worker mesh (secret
//                               binding, jamais une var, jamais le frontend)
//   MESH_PUBLIC_URL           → base du worker mesh (…/mesh/ws)
//   MESH_SOURCE_ALLOWLIST     → CSV de sourceId autorisés ("*" = tous) ; c'est
//                               le pré-positionnement du flag « par source » en
//                               attente de la colonne Source.p2pEnabled (étape 5).
//   MESH_TESTER_ALLOWLIST     → CANARY privé (étape 6) : CSV d'appareils
//                               testeurs autorisés. Absent/vide = AUCUNE
//                               restriction (compatibilité) — les déploiements
//                               canary DOIVENT le renseigner (JAMAIS "*").
//                               Entrées acceptées : deviceId brut OU
//                               sha256Hex(deviceId) (64 hex, préféré : évite de
//                               stocker l'identifiant brut dans l'env).
//                               "*" = ouvert explicite (INTERDIT en canary).
//                               Hors liste → { p2p:false } (lecture intacte).
//   MESH_ENFORCE_ALLOWLIST="1"  → MODE STRICT canary (obligatoire sur l'API de
//                               test) : une allowlist testeurs absente, vide ou
//                               "*" REFUSE tout jeton (fail closed). Sans ce
//                               mode, l'absence de liste reste permissive
//                               (compatibilité historique).
// Toute anomalie (secret absent, source hors liste, calcul qui échoue) donne
// { p2p:false, …null } — JAMAIS une erreur de lecture : le refus P2P ne doit
// jamais empêcher de regarder la chaîne.
// ============================================================================
import { computeMeshSwarmId, createMeshToken, deriveMeshDid, newMeshPeerId } from "@mbolo/contracts";
import { sha256Hex } from "./crypto.js";

const TOKEN_MAX_TTL_MS = 6 * 3_600_000;  // un pair de 6 h sans renouvellement est éjectable proprement
const TOKEN_MIN_TTL_MS = 15 * 60_000;    // jamais un jeton plus court que 15 min (bruit d'aller-retour)

function enabled(env) {
  return String(env?.MESH_ENABLED ?? "").trim() === "1"
    && String(env?.MESH_URL_SECRET ?? "").trim() !== ""
    && String(env?.MESH_PUBLIC_URL ?? "").trim() !== "";
}

function sourceAllowed(env, sourceId) {
  const raw = String(env?.MESH_SOURCE_ALLOWLIST ?? "").trim();
  if (!raw) return false;                       // par défaut : AUCUNE source (opt-in explicite)
  if (raw === "*") return true;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(sourceId);
}

const OFF = { p2p: false, meshToken: null, meshUrl: null, meshExpiresAt: null };

/**
 * Porte canary « par testeur » (étape 6). Purement additive : sans
 * MESH_TESTER_ALLOWLIST le comportement est inchangé (aucune restriction).
 * Avec une liste renseignée, seuls les appareils listés reçoivent un jeton ;
 * les autres retombent en OFF — le datapath vidéo n'est jamais touché.
 * Compare le deviceId brut ET son sha256 (l'opérateur peut inscrire l'un ou
 * l'autre ; le hash est préféré pour ne pas figer l'identifiant brut).
 * "*" = ouvert explicite (réservé aux environnements de test automatisé,
 * JAMAIS en canary réel). Ne jette jamais : doute = refus P2P, pas d'erreur.
 */
export function meshTesterAllowed(env, deviceId, deviceHash) {
  try {
    const raw = String(env?.MESH_TESTER_ALLOWLIST ?? "").trim();
    const strict = String(env?.MESH_ENFORCE_ALLOWLIST ?? "").trim() === "1";
    // Mode strict (API canary) : sans liste explicite et non-"*", PERSONNE ne
    // reçoit de jeton. Une mauvaise configuration coupe le P2P au lieu de
    // l'ouvrir à tout le monde (fail closed).
    if (!raw || raw === "*") return strict ? false : true;
    if (!deviceId) return false;
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) return false;
    if (list.includes(deviceId)) return true;
    if (deviceHash) {
      const lower = String(deviceHash).toLowerCase();
      for (const entry of list) {
        if (entry.length === 64 && entry.toLowerCase() === lower) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * @param ctx.env  bindings Worker
 * @param session { channelId, sourceId, variantId, eco } — identité RÉELLE de
 *        la session de lecture choisie (variante sélectionnée, plafond éco
 *        appliqué), issues du SELECT de selectVariant()/findMatchVariants().
 * @param playExpiresAt  expiresAt ISO de PlayResponse (fin du jeton de lecture)
 * @returns les champs mesh à fusionner dans PlayResponse. {} = réponse
 *          strictement identique à l'existant (mesh globalement inconnu).
 */
export async function meshFieldsForPlay(env, deviceId, session, playExpiresAt) {
  if (!enabled(env)) return {};                 // flag absent = NE TOUCHE PAS à la réponse actuelle
  try {
    if (!deviceId || !session?.sourceId || !session?.variantId || !session?.channelId) return OFF;
    if (!sourceAllowed(env, session.sourceId)) return OFF;
    const secret = String(env.MESH_URL_SECRET).trim();
    const ecoFlag = session.eco ? "eco" : "hd";
    const [swarmId, deviceHash] = await Promise.all([
      computeMeshSwarmId(secret, {
        sourceId: session.sourceId,
        channelId: session.channelId,
        variantId: session.variantId,
        ecoFlag,
      }),
      sha256Hex(deviceId),
    ]);
    // Porte canary par testeur : hors liste → OFF (pas de jeton, lecture intacte).
    if (!meshTesterAllowed(env, deviceId, deviceHash)) return OFF;
    const now = Date.now();
    // Rotation quotidienne de la clé de limitation : le coordinateur ne voit
    // jamais deviceHash, jamais une IP, et un did d'hier ne corrèle pas avec
    // un did d'aujourd'hui (anti-tracking, spec §3.1).
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const did = await deriveMeshDid(secret, deviceHash, dayKey);
    const ttl = Math.min(
      Math.max(new Date(playExpiresAt).getTime() - now, TOKEN_MIN_TTL_MS),
      TOKEN_MAX_TTL_MS,
    );
    const peerId = newMeshPeerId();             // 16 octets aléatoires : AUCUN lien avec deviceId
    const meshToken = await createMeshToken(secret, { v: 1, pid: peerId, sid: swarmId, did, iat: now, exp: now + ttl });
    const meshUrl = `${String(env.MESH_PUBLIC_URL).trim().replace(/\/+$/, "")}/mesh/ws`;
    return { p2p: true, meshToken, meshUrl, meshExpiresAt: now + ttl };
  } catch {
    return OFF;                                 // jamais une erreur de lecture à cause du mesh
  }
}
