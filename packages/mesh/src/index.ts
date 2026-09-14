// @mbolo/mesh — MeshStream POC (ADR-0004 étape 4). Point d'entrée public.
// Aucune dépendance runtime : WebRTC natif, fetch natif, contrats partagés.
// Le web ne charge ce code QUE si (a) /play a renvoyé p2p:true avec un jeton,
// (b) le navigateur a MSE+WebRTC+DataChannel, (c) le flag POC local est activé.
export { MeshClient, NOOP_METRICS, type MeshClientOptions, type MeshMetrics } from './mesh-client';
export { SegmentCache, sha256Hex, type CachedSegment } from './memory-cache';
export { PersistentCache, InMemoryStore, type SegmentStore, type PersistentSegment, type PersistentSegmentMeta, type PersistentStats, type PersistentCacheOptions } from './persistent-cache';
export { PeerScore, type PeerScoreSnapshot, type PeerScoreFactors, type PeerFailureKind, type PeerScoreSample } from './peer-score';
export { MeshLoader, type LoaderDeps, type FragLite } from './mesh-loader';
export { PeerManager, type PeerManagerOptions, type SignalSink } from './peer-manager';
export { PeerLink, DATA_CHANNEL_LABEL, type RtcEnv, type SegmentResult, type AnnouncedWindow, type MeshPeerLinkState } from './peer-link';
export { Signaling, derivePollBase, type SignalingTransport, type SignalingOptions } from './signaling';
export { decodeFrame, splitFrames, FRAME_HEADER_BYTES } from './transport';
export { consoleMeshTrace, createMeshTraceCollector, findMeshTraceLeak, assertMeshTracePrivacy, meshSegmentId, classifyDeviceClass, sanitizeNetworkType, type MeshTrace, type MeshTraceEvent, type MeshTraceRtcState, type MeshDeviceClass, type MeshVisibility, type MeshTraceCollector, type CollectedMeshEvent } from './trace';
export { detectMeshCapabilities, defaultCapacityFor, shouldPauseSeeding, type MeshCapabilities } from './capabilities';
export { MeshSession, createMeshSession, computeMeshRid, type MeshSessionOptions, type MeshStats, type RenditionAttrs, type OriginLoaderCtor } from './mesh-session';

// Le rid (identité de rendition, spec §6.1) : UNE seule implémentation,
// computeMeshRid ci-dessus (sha256(cana("RESOLUTION,BANDWIDTH,CODECS"))[:8])
// — la frontière de sécurité reste le swarmId HMAC serveur ; rid ne fait que
// refuser l'échange entre renditions incompatibles.
export { MESH_PROTOCOL_VERSION } from '@mbolo/contracts';
