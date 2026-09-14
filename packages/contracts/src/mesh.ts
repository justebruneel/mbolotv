// ============================================================================
// MeshStream v1 — contrats du protocole de coordination P2P (ADR-0004).
//
// CE FICHIER NE FAIT QUE DÉCRIRE LE PROTOCOLE. Aucun code de streaming,
// aucun lecteur, aucun worker ne l'utilise encore : le P2P est inactif tant
// que l'API ne délivre pas de meshToken (PlayResponse.p2p absent/faux) et
// tant que le worker mbolo-tv-mesh n'est pas déployé.
//
// Deux protocoles distincts, volontairement séparés :
//   1. SIGNALING  client <-> coordinateur (WebSocket, repli HTTP polling)
//   2. SEGMENT    peer <-> peer (DataChannel WebRTC) — le coordinateur ne
//      voit jamais ces messages ni les octets vidéo.
//
// Règle de versionnage : `v` est un entier strict. Une évolution additive =
// nouveaux types de message ou champs .optional(). Un champ obligatoire ne
// change jamais de sémantique : il change de NOM et fait monter `v`.
// Les champs inconnus au niveau enveloppe sont ignorés (extensibilité) ;
// le payload `d` est validé strictement (refus explicite, jamais de silence).
// ============================================================================
import { z } from 'zod';

// ---- Constantes de protocole (source unique de vérité des nombres) --------
export const MESH_PROTOCOL_VERSION = 1;
export const MESH_MIN_PROTOCOL_VERSION_DEFAULT = 1;

/** Enveloppe JSON d'un message de signaling (texte WS). Au-delà : RATE_LIMITED/KICK. */
export const MESH_MAX_MESSAGE_BYTES = 8192;
/** Corps binaire d'un chunk de segment sur le DataChannel (en-tête de trame inclus). */
export const MESH_MAX_CHUNK_BYTES = 65536;
/** Taille maximale d'un segment accepté (256 Mo : garde-fou absolu ; les segments live font ~500 Ko). */
export const MESH_MAX_SEGMENT_BYTES = 268_435_456;
/** Fenêtre glissante max annoncée par un peer (segments). ~96 s à 4 s/segment. */
export const MESH_MAX_WINDOW_SEGMENTS = 24;
/** Nombre max de candidats renvoyés par JOIN_ACCEPTED / PEER_CANDIDATES. */
export const MESH_MAX_CANDIDATES = 12;
/** Fan-out : connexions simultanées par défaut / plafond dur. */
export const MESH_DEFAULT_MAX_PEERS = 4;
export const MESH_HARD_MAX_PEERS = 6;
/** Affiche de membres d'un swarm au-delà de laquelle on refuse de nouveaux joins (le dernier arrivé bascule origin sans erreur). */
export const MESH_SWARM_SOFT_LIMIT = 1500;
/** SDP offer/answer : plafond de taille (les SDP réels font 4-6 Ko). */
export const MESH_MAX_SDP_BYTES = 16384;

// ---- Budget du cache persistant IndexedDB (étape 5 — source unique de ces
// nombres : le client les lit ici, AUCUNE valeur n'est recopiée ailleurs). ----
/** Plafond d'octets stockés (~150 Mo : 4× le budget mémoire v1, borné dur). */
export const MESH_PERSIST_MAX_BYTES = 150 * 1024 * 1024;
/** Plafond d'entrées (cohérent avec le cache mémoire de 80 segments ; la
 *  fenêtre live à 90 s d'âge en tient de toute façon beaucoup moins). */
export const MESH_PERSIST_MAX_SEGMENTS = 80;
/** Âge max d'une entrée : MeshStream est un système LIVE — le cache n'est
 *  JAMAIS une médiathèque. Au-delà, l'entrée est évincée (LRU secondaire). */
export const MESH_PERSIST_MAX_AGE_MS = 90_000;
/** Garde de lecture : une attente IndexedDB ne doit jamais retarder un pari
 *  origin. Au-delà, le loader considèrent le miss et poursuit sa hiérarchie. */
export const MESH_PERSIST_READ_TIMEOUT_MS = 250;

// ---- Identifiants opaques ---------------------------------------------------
// swarmId : 32 hex = 128 bits tronqués d'un HMAC-SHA256 (cf. docs/architecture/meshstream.md §2).
// Ne révèle jamais sourceId/channelId/variantId : seul le serveur qui détient le
// secret MESH_URL_SECRET peut recalculer ou vérifier un swarmId.
export const meshSwarmIdSchema = z.string().regex(/^[0-9a-f]{32}$/, 'swarmId invalide');
// peerId : 16 octets aléatoires par session de lecture, base64url sans padding (22 caractères).
// Éphémère : jamais dérivé du deviceId ni du deviceHash, jamais persisté par le client.
export const meshPeerIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/, 'peerId invalide');
// did : identifiant de rate-limit dérivé serveur (HMAC(secret, deviceHash|jour)), rotation quotidienne.
// Le coordinateur voit `did`, jamais deviceHash, jamais deviceId.
export const meshDeviceLimitIdSchema = z.string().regex(/^[0-9a-f]{32}$/, 'did invalide');
// Nonce de requête segment (anti rejeu / appariement requête-réponse sur DataChannel).
export const meshRequestNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{16,32}$/, 'nonce invalide');

// ---- Vocabulaires partagés ---------------------------------------------------
export const meshCapacitySchema = z.enum(['off', 'low', 'normal']);
export type MeshCapacity = z.infer<typeof meshCapacitySchema>;

export const meshNetworkTypeSchema = z.enum(['wifi', 'cellular', 'wired', 'unknown']);
export type MeshNetworkType = z.infer<typeof meshNetworkTypeSchema>;

/** Fenêtre glissante compacte : segments [first..last] (sn absolus) sous un even cc. */
export const meshSegmentWindowSchema = z.object({
  cc: z.number().int().min(0).max(0xffff),
  first: z.number().int().min(0),
  last: z.number().int().min(0),
}).refine((w) => w.last - w.first < MESH_MAX_WINDOW_SEGMENTS, { message: 'fenêtre trop large' });
export type MeshSegmentWindow = z.infer<typeof meshSegmentWindowSchema>;

/** Signature de rendition (8 hex) : sha256(cana("{RESOLUTION},{BANDWIDTH},{CODECS}")) du level choisi. Deux peers ne partagent des segments que si rid est égal (le swarm peut contenir plusieurs renditions). */
export const meshRenditionIdSchema = z.string().regex(/^[0-9a-f]{8}$/, 'rid invalide');

export const meshPeerStateSchema = z.enum([
  'JOINING', 'DISCOVERING', 'CONNECTING', 'CONNECTED',
  'HEALTHY', 'DEGRADED', 'UNRELIABLE', 'DRAINING', 'DISCONNECTED',
]);
export type MeshPeerState = z.infer<typeof meshPeerStateSchema>;

export const meshErrorCodeSchema = z.enum([
  'INVALID_TOKEN', 'TOKEN_EXPIRED', 'INVALID_SWARM', 'PROTOCOL_UNSUPPORTED',
  'PEER_NOT_FOUND', 'RATE_LIMITED', 'SWARM_FULL', 'INVALID_MESSAGE',
  'PEER_DRAINING', 'INTERNAL',
]);
export type MeshErrorCode = z.infer<typeof meshErrorCodeSchema>;

/** Codes d'erreur du protocole peer-to-peer (distincts de ceux du signaling). */
export const meshP2pErrorCodeSchema = z.enum([
  'SEGMENT_NOT_AVAILABLE', 'BAD_REQUEST', 'OVERLOADED',
  'CHECKSUM_MISMATCH', 'PROTOCOL_UNSUPPORTED', 'INTERNAL',
]);
export type MeshP2pErrorCode = z.infer<typeof meshP2pErrorCodeSchema>;

/** Motif de repli origin (télémétrie FALLBACK_PING uniquement — aucune action serveur n'en dépend). */
export const meshFallbackReasonSchema = z.enum([
  'NO_PEERS', 'PEER_TIMEOUT', 'PEER_FAILED', 'BUFFER_CRITICAL', 'LIVE_EDGE', 'TOKEN_LOST', 'CORRUPT_SEGMENT',
]);
export type MeshFallbackReason = z.infer<typeof meshFallbackReasonSchema>;

// ---- Configuration dynamique (message CONFIG, kill switch inclus) ------------

/** Scoring local des pairs (étape 5 — spec §12 : le coordinateur fournit des
 *  candidats, le CLIENT choisit). Les poids et seuils vivent ICI (source
 *  unique) ; le client les lit depuis MESH_SCORE_DEFAULTS ou l'override
 *  éventuel du serveur (champ optionnel `score` de meshConfigSchema).
 *  Chaque facteur est ramené dans [0..1] avant combinaison : aucun ne domine
 *  artificiellement les autres (les poids n'ont pas à sommer à 1). */
export const meshScoreWeightsSchema = z.object({
  success: z.number().min(0).max(1),
  throughput: z.number().min(0).max(1),
  rtt: z.number().min(0).max(1),
  freshness: z.number().min(0).max(1),
  upload: z.number().min(0).max(1),
  stability: z.number().min(0).max(1),
});
export type MeshScoreWeights = z.infer<typeof meshScoreWeightsSchema>;

export const meshScoreConfigSchema = z.object({
  weights: meshScoreWeightsSchema,
  /** Facteur d'adoucissement EWMA (0..1) : plus haut = réactif, plus bas = stable. */
  alpha: z.number().min(0.05).max(0.9),
  /** Échecs DURS consécutifs avant marquer UNRELIABLE. */
  unreliableAfter: z.number().int().min(2).max(5),
  /** Cooldown initial d'un pair UNRELIABLE (10 min par défaut, §14 brief
   *  étape 5) ; prolongé par `cooldownEscalation` à chaque rechute. */
  cooldownMs: z.number().int().min(30_000).max(3_600_000),
  cooldownEscalation: z.number().min(1).max(4),
  /** Âge d'annonce au-delà duquel la fenêtre d'un pair ne vaut plus rien
   *  (fraîcheur à 0) : le direct bouge, l'annonce est périssable. */
  windowStaleMs: z.number().int().min(10_000).max(300_000),
  /** Le loader ne parie sur un pair que si son meilleur score atteint ce
   *  seuil (échecs récents → backoff origin, §25 brief étape 5). */
  trustThreshold: z.number().min(0).max(1),
  /** Fenêtre de backoff après `backoffAfter` échecs pair consécutifs. */
  backoffMs: z.number().int().min(5_000).max(300_000),
  backoffAfter: z.number().int().min(1).max(5),
  /** Deux pairs dont les scores diffèrent de moins de cet epsilon sont
   *  « équivalents » : rotation DÉTERMINISTE (diversité §23, debuggable). */
  diversityEpsilon: z.number().min(0).max(0.5),
});
export type MeshScoreConfig = z.infer<typeof meshScoreConfigSchema>;

export const MESH_SCORE_DEFAULTS: MeshScoreConfig = {
  weights: { success: 0.30, throughput: 0.30, rtt: 0.12, freshness: 0.12, upload: 0.08, stability: 0.08 },
  alpha: 0.3,
  unreliableAfter: 3,
  cooldownMs: 600_000,
  cooldownEscalation: 2,
  windowStaleMs: 60_000,
  trustThreshold: 0.35,
  backoffMs: 60_000,
  backoffAfter: 2,
  diversityEpsilon: 0.05,
};

export const meshConfigSchema = z.object({
  p2pEnabled: z.boolean().optional(),           // absent = le serveur ne le communique pas (pas de faux positif)
  maxPeers: z.number().int().min(0).max(MESH_HARD_MAX_PEERS),
  peerTimeoutMs: z.number().int().min(300).max(5000),        // délai max avant repli origin sur un pair
  bufferCriticalSec: z.number().int().min(4).max(60),        // sous ce niveau de buffer : origin direct, jamais de pari peer
  liveEdgeSafetySegments: z.number().int().min(1).max(10),   // les N derniers du direct viennent toujours de l'origin
  heartbeatMs: z.number().int().min(10_000).max(120_000),
  statsIntervalMs: z.number().int().min(30_000).max(600_000),
  pollIntervalMs: z.number().int().min(2_000).max(30_000),   // repli sans WebSocket
  candidateSample: z.number().int().min(1).max(MESH_MAX_CANDIDATES),
  windowSize: z.number().int().min(4).max(MESH_MAX_WINDOW_SEGMENTS),
  chunkBytes: z.number().int().min(16_384).max(MESH_MAX_CHUNK_BYTES),
  protocolVersion: z.number().int(),
  minProtocolVersion: z.number().int(),
  /** Scoring client (étape 5) : ABSENT = le serveur ne tranche pas, le client
   *  utilise MESH_SCORE_DEFAULTS. Additif v1 (champ optionnel). */
  score: meshScoreConfigSchema.optional(),
});
export type MeshConfig = z.infer<typeof meshConfigSchema>;

// ---- Enveloppe de signaling --------------------------------------------------
export const meshEnvelopeBaseSchema = z.object({
  v: z.literal(MESH_PROTOCOL_VERSION),
  t: z.string().min(1).max(32),
  sid: meshSwarmIdSchema,
  id: meshPeerIdSchema,
  seq: z.number().int().min(0).max(0xffffffff),   // séquence par connection (anti-rejeu local, ordonnancement)
  ts: z.number().int().positive(),                // unix ms horloge client (diagnostic seulement, jamais confiance)
});
export type MeshEnvelopeBase = z.infer<typeof meshEnvelopeBaseSchema>;

// ---- Messages CLIENT -> COORDINATEUR -------------------------------------------
// Le meshToken n'est PAS dans les messages : il est présenté une seule fois au
// handshake WS (?token=) ou à chaque poll (?token=). Toute la suite de la
// connexion est rattachée à ce peerId/sid vérifiés au handshake.

export const meshJoinSwarmSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('JOIN_SWARM'),
  d: z.object({
    proto: z.number().int().min(1),
    cap: meshCapacitySchema,
    net: meshNetworkTypeSchema,
    rid: meshRenditionIdSchema.nullable().optional(), // avant LEVEL_SWITCHED : null (le coord ne filtre pas dessus)
  }).strict(),
});
export const meshLeaveSwarmSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('LEAVE_SWARM'),
  d: z.object({ reason: z.enum(['user', 'switching', 'pagehide', 'network', 'error']).optional() }).strict(),
});
export const meshHeartbeatSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('HEARTBEAT'),
  d: z.object({
    win: meshSegmentWindowSchema.nullable().optional(),  // null = rien de seedable (juste join, buffer en cours)
    rid: meshRenditionIdSchema.nullable().optional(),
    cap: meshCapacitySchema,                             // le peer peut déclarer une baisse (batterie, cellulaire)
  }).strict(),
});
export const meshStatsReportSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('STATS_REPORT'),
  d: z.object({
    upBytes: z.number().int().min(0).max(1e12),          // octets uploadés vers des peers depuis le dernier report
    peerDlBytes: z.number().int().min(0).max(1e12),      // octets reçus de peers
    peerOk: z.number().int().min(0).max(1e6),
    peerFail: z.number().int().min(0).max(1e6),
    rttMs: z.number().int().min(0).max(10_000).nullable().optional(), // moyenne sur le DataChannel le plus rapide
  }).strict(),
});
export const meshFallbackPingSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('FALLBACK_PING'),
  d: z.object({
    sn: z.number().int().min(0),
    reason: meshFallbackReasonSchema,
  }).strict(),
});
// Signalization WebRTC : le coordinateur ROUTE, il n'interprète jamais le SDP.
// `to` est présent côté client-émetteur ; côté récepteur le coordinateur
// remplace `to` par `from` (variantes coordonnées ci-dessous).
export const meshSignalOfferSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('SIGNAL_OFFER'),
  d: z.object({
    to: meshPeerIdSchema,
    sdp: z.string().min(20).max(MESH_MAX_SDP_BYTES),
  }).strict(),
});
export const meshSignalAnswerSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('SIGNAL_ANSWER'),
  d: z.object({
    to: meshPeerIdSchema,
    sdp: z.string().min(20).max(MESH_MAX_SDP_BYTES),
  }).strict(),
});
export const meshIceCandidateSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('ICE_CANDIDATE'),
  d: z.object({
    to: meshPeerIdSchema,
    // batch de candidats ICE sérialisés côté client (format SDP "candidate:" brut, opacité totale)
    c: z.array(z.string().min(1).max(1024)).min(1).max(32),
  }).strict(),
});

export const meshClientMessageSchema = z.discriminatedUnion('t', [
  meshJoinSwarmSchema, meshLeaveSwarmSchema, meshHeartbeatSchema,
  meshStatsReportSchema, meshFallbackPingSchema,
  meshSignalOfferSchema, meshSignalAnswerSchema, meshIceCandidateSchema,
]);
export type MeshClientMessage = z.infer<typeof meshClientMessageSchema>;

// ---- Messages COORDINATEUR -> CLIENT -------------------------------------------

/** Fiche peer dans les listes de candidats / JOIN_ACCEPTED. */
export const meshPeerSummarySchema = z.object({
  id: meshPeerIdSchema,
  cap: meshCapacitySchema,
  win: meshSegmentWindowSchema.nullable().optional(),
  rid: meshRenditionIdSchema.nullable().optional(),
  proto: z.number().int().min(1),
});
export type MeshPeerSummary = z.infer<typeof meshPeerSummarySchema>;

export const meshJoinAcceptedSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('JOIN_ACCEPTED'),
  d: z.object({
    peers: z.array(meshPeerSummarySchema).max(MESH_MAX_CANDIDATES),
    cfg: meshConfigSchema,
  }).strict(),
});
export const meshPeerCandidatesSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('PEER_CANDIDATES'),
  d: z.object({ peers: z.array(meshPeerSummarySchema).max(MESH_MAX_CANDIDATES) }).strict(),
});
export const meshPeerJoinedSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('PEER_JOINED'),
  d: z.object(meshPeerSummarySchema.shape).strict(),
});
export const meshPeerRemoveSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('PEER_REMOVE'),
  d: z.object({
    ids: z.array(meshPeerIdSchema).min(1).max(32),
    why: z.enum(['left', 'timeout', 'kicked', 'draining', 'unhealthy']).optional(),
  }).strict(),
});
export const meshConfigMessageSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('CONFIG'),
  d: meshConfigSchema,
});
export const meshKickSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('KICK'),
  d: z.object({ why: z.enum(['rate_limit', 'protocol', 'abuse', 'admin']).optional() }).strict(),
});
export const meshDrainSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('DRAIN'),
  d: z.object({ inMs: z.number().int().min(0).max(60_000).optional() }).strict(),
});
export const meshErrorSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('ERROR'),
  d: z.object({
    code: meshErrorCodeSchema,
    retryAfterMs: z.number().int().min(0).max(600_000).optional(),
  }).strict(),
});
// Routage descendant : mêmes payloads que montée, `to` remplacé par `from`.
export const meshSignalOfferDeliveredSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('SIGNAL_OFFER'),
  d: z.object({
    from: meshPeerIdSchema,
    sdp: z.string().min(20).max(MESH_MAX_SDP_BYTES),
  }).strict(),
});
export const meshSignalAnswerDeliveredSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('SIGNAL_ANSWER'),
  d: z.object({
    from: meshPeerIdSchema,
    sdp: z.string().min(20).max(MESH_MAX_SDP_BYTES),
  }).strict(),
});
export const meshIceCandidateDeliveredSchema = meshEnvelopeBaseSchema.extend({
  t: z.literal('ICE_CANDIDATE'),
  d: z.object({
    from: meshPeerIdSchema,
    c: z.array(z.string().min(1).max(1024)).min(1).max(32),
  }).strict(),
});

export const meshCoordinatorMessageSchema = z.discriminatedUnion('t', [
  meshJoinAcceptedSchema, meshPeerCandidatesSchema, meshPeerJoinedSchema,
  meshPeerRemoveSchema, meshConfigMessageSchema, meshKickSchema, meshDrainSchema,
  meshErrorSchema,
  meshSignalOfferDeliveredSchema, meshSignalAnswerDeliveredSchema, meshIceCandidateDeliveredSchema,
]);
export type MeshCoordinatorMessage = z.infer<typeof meshCoordinatorMessageSchema>;

// ---- Protocole PEER -> PEER (DataChannel — jamais vu par le coordinateur) ------
// Trames de contrôle : JSON texte ci-dessous. Trames de données : binaire,
// en-tête 7 octets documenté dans docs/architecture/meshstream.md §6.4.
// Règle racine : tout pair est NON FIABLE. Nulle confiance sans vérification.

export const meshP2pEnvelopeBaseSchema = z.object({
  v: z.literal(MESH_PROTOCOL_VERSION),
  t: z.string().min(1).max(24),
  seq: z.number().int().min(0).max(0xffffffff),
});

export const meshP2pHelloSchema = meshP2pEnvelopeBaseSchema.extend({
  t: z.literal('HELLO'),
  d: z.object({
    proto: z.number().int().min(1),
    cap: meshCapacitySchema,
    sid: meshSwarmIdSchema,                       // auto-contrôle : le pair doit être dans le même swarm
    rid: meshRenditionIdSchema,
  }).strict(),
});
export const meshP2pSegmentRequestSchema = meshP2pEnvelopeBaseSchema.extend({
  t: z.literal('SEGMENT_REQUEST'),
  d: z.object({
    n: meshRequestNonceSchema,                    // nonce du demandeur, écho obligatoire dans la réponse
    cc: z.number().int().min(0).max(0xffff),
    sn: z.number().int().min(0),
  }).strict(),
});
export const meshP2pSegmentHeaderSchema = meshP2pEnvelopeBaseSchema.extend({
  t: z.literal('SEGMENT_HEADER'),
  d: z.object({
    n: meshRequestNonceSchema,
    cc: z.number().int().min(0).max(0xffff),
    sn: z.number().int().min(0),
    len: z.number().int().min(1).max(MESH_MAX_SEGMENT_BYTES),
    chunks: z.number().int().min(1).max(8192),    // nb de trames binaires qui suivent
    // bid : identifiant de transfert (uint32) porté par les TRAMES BINAIRES qui
    // suivent, pour les associer à cette requête sur un canal partagé (additif v1).
    bid: z.number().int().min(0).max(0xffffffff).optional(),
  }).strict(),
});
export const meshP2pSegmentCompleteSchema = meshP2pEnvelopeBaseSchema.extend({
  t: z.literal('SEGMENT_COMPLETE'),
  d: z.object({
    n: meshRequestNonceSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),   // hash CALCULÉ PAR L'ÉMETTEUR sur les octets qu'il croit envoyer
  }).strict(),                                     // (pas de hash origin : cf. ADR-0004 — stratégie d'intégrité en 3 couches)
});
export const meshP2pPingSchema = meshP2pEnvelopeBaseSchema.extend({
  t: z.literal('PING'),
  d: z.object({ t0: z.number().int().positive() }).strict(),
});
export const meshP2pPongSchema = meshP2pEnvelopeBaseSchema.extend({
  t: z.literal('PONG'),
  d: z.object({ t0: z.number().int().positive() }).strict(),
});
export const meshP2pErrorSchema = meshP2pEnvelopeBaseSchema.extend({
  t: z.literal('ERROR'),
  d: z.object({
    n: meshRequestNonceSchema.nullable().optional(),
    code: meshP2pErrorCodeSchema,
  }).strict(),
});

export const meshP2pMessageSchema = z.discriminatedUnion('t', [
  meshP2pHelloSchema, meshP2pSegmentRequestSchema, meshP2pSegmentHeaderSchema,
  meshP2pSegmentCompleteSchema, meshP2pPingSchema, meshP2pPongSchema, meshP2pErrorSchema,
]);
export type MeshP2pMessage = z.infer<typeof meshP2pMessageSchema>;

// ---- MeshToken (structure logique du payload signé) -----------------------------
// Format de jeton (sans dépendance JWT, même famille que la signature x-sig du
// video-proxy) : b64url(JSON) + "." + b64url(HMAC-SHA256(MESH_URL_SECRET, b64url(JSON))).
// Le worker mesh vérifie avec le secret partagé uniquement — ZÉRO appel Postgres.
export const meshTokenPayloadSchema = z.object({
  v: z.literal(1),
  pid: meshPeerIdSchema,          // pair autorisé
  sid: meshSwarmIdSchema,         // swarm autorisé (ce pair, ce flux, cette config)
  did: meshDeviceLimitIdSchema,   // rate-limit appareil (rotation quotidienne), sans deviceHash
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
}).strict(); // strict : AUCUN champ de données personnelles ne peut s'immiscer dans le jeton
export type MeshTokenPayload = z.infer<typeof meshTokenPayloadSchema>;

/** Réponse de GET /api/channels/:id/play une fois MeshStream activé (§4 du plan).
    p2p est ABSENT de la réponse actuelle ; ces champs optionnels sont rétrocompatibles.
    expiresAt (ms epoch) = fin de validité du meshToken — le client le sait sans
    décoder le jeton ; les trois champs viennent toujours ensemble ou pas du tout. */
export const meshPlayFieldsSchema = z.object({
  p2p: z.boolean().optional(),
  meshToken: z.string().max(2048).nullable().optional(),
  meshUrl: z.string().url().nullable().optional(),
  meshExpiresAt: z.number().int().nullable().optional(),
});
export type MeshPlayFields = z.infer<typeof meshPlayFieldsSchema>;
