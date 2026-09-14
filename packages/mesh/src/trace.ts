// ============================================================================
// trace.ts — Instrumentation [mesh-test] (étapes 6, brief §8 + phase canary).
//
// Sink optionnel injecté de bout en bout du client mesh. ABSENT par défaut :
// zéro coût, zéro log. Présent (uniquement dans l'environnement de test,
// branché par poc.ts derrière le flag de build (NEXT_PUBLIC_MESH_ENABLED,
// legacy NEXT_PUBLIC_MESH_POC) + jeton serveur),
// il émet des ÉVÉNEMENTS STRUCTURÉS permettant de reconstituer, pour chaque
// session et chaque segment : qui a servi, par quel tier, en combien de temps,
// pourquoi un pair a été écarté, et — nouveauté canary — de CORRÉLER deux
// appareils (A demandeur, B seed) via un traceId aléatoire non personnel.
//
// RÈGLES DE CONFIDENTIALITÉ (brief §8/§29 — absolu) :
//   - JAMAIS un meshToken, un x-sig/x-exp, une URL fournisseur, une IP,
//     un DeviceGrant, un deviceId, un contenu vidéo ;
//   - les candidats ICE ne sont décrits que par TYPE (host | srflx | relay)
//     — jamais par adresse ;
//   - `pid` est le peerId ÉPHÉMÈRE déjà connu du swarm (16 octets aléatoires
//     par session, jamais lié à un compte) : c'est l'identifiant d'un test,
//     pas d'une personne.
//   - `tid` (traceId de transfert) est le nonce SEGMENT_REQUEST (16-32
//     base64url aléatoires par demande) : partagé par A et B pour CE transfert
//     uniquement, il permet la jointure A↔B sans rien révéler d'autre.
//   - `sid8` est le swarmId TRONQUÉ à 8 hex (label opaque, pas l'identité
//     complète, jamais sourceId/channelId).
//   - l'identité d'un segment est `swarm8:cc:sn` — JAMAIS l'URL.
//
// Format de sortie décidé par le CONSOMMATEUR du sink (console dans le web,
// collecteur borné pour window.__meshTest.dump(), tableau dans les tests) :
// ce module ne fait que DÉFINIR le vocabulaire + le collecteur + le garde-fou
// anti-fuite. L'enrichissement temporel (at/rel) est fait par le COLLECTEUR,
// pas par les émetteurs.
// ============================================================================

/** État WebRTC brut pertinent pour classer une connexion (§9). */
export interface MeshTraceRtcState {
  ice: string;            // RTCPeerConnection.iceConnectionState
  gathering: string;      // iceGatheringState
  connection: string;     // connectionState
}

/** Classe d'appareil NON personnelle (dérivée de l'UA, UA jamais stockée). */
export type MeshDeviceClass = 'desktop' | 'mobile' | 'tv' | 'webview' | 'unknown';
export type MeshVisibility = 'foreground' | 'background';

export type MeshTraceEvent =
  /** Ouverture de session de test (émise une fois par le pont web). */
  | { t: 'session'; sid8: string; pid: string; proto: number; cap: 'off' | 'low' | 'normal'; net: 'wifi' | 'cellular' | 'wired' | 'unknown'; deviceClass: MeshDeviceClass; visibility: MeshVisibility; peers: number }
  /** Transition ICE d'un lien pair (classification DIRECT/STUN/FAILED §9). */
  | { t: 'ice'; pid: string; ms: number; state: MeshTraceRtcState }
  /** Issue d'une tentative ICE : durée + succès/échec + raison de fermeture. */
  | { t: 'iceResult'; pid: string; ok: boolean; ms: number; reason: string }
  /** Paire de candidats sélectionnée après connexion — TYPES uniquement. */
  | { t: 'candidatePair'; pid: string; local: string; remote: string }
  /** DataChannel mesh-v1 ouvert/fermé/erreur. */
  | { t: 'dc'; pid: string; state: 'open' | 'close' | 'error' }
  /** Statistiques de vie d'un DataChannel, émises à la fermeture. */
  | { t: 'dcStats'; pid: string; lifetimeMs: number; sentBytes: number; recvBytes: number; sentMsgs: number; recvMsgs: number; backpressure: number; timeouts: number; aborts: number; errors: number }
  /** Backpressure observée côté émetteur (bufferedAmount au-delà du seuil). */
  | { t: 'backpressure'; pid: string }
  /** HELLO validé (ou lien fermé pour cross-swarm/rendition). */
  | { t: 'hello'; pid: string; ok: boolean }
  /** Un pair a été RETENU comme premier choix pour (cc,sn) avec son score. */
  | { t: 'selected'; pid: string; score: number; cc: number; sn: number }
  /** Un pair écarté par rank() et POURQUOI (cooldown, hors fenêtre, cap off…). */
  | { t: 'skipped'; pid: string; why: string }
  /** Résultat d'une demande peer→peer : octets, durée, échec+raison. */
  | { t: 'peerResult'; pid: string; ok: boolean; bytes: number; ms: number; reason?: string }
  /** Transfert corrélable A↔B : `tid` = nonce SEGMENT_REQUEST partagé. */
  | { t: 'transfer'; tid: string; pid: string; role: 'req' | 'srv'; cc: number; sn: number; ok: boolean; bytes: number; ms: number; reason?: string }
  /** Segment livré par un tier du loader (le décompte officiel §11 : seuls
   *  tier='peer' et tier='origin' comptent dans le peer_ratio). */
  | { t: 'tier'; cc: number; sn: number; tier: 'memory' | 'idb' | 'peer' | 'origin'; ms: number }
  /** Repli origin explicite : quel segment, pourquoi, après combien de ms. */
  | { t: 'fallback'; cc: number; sn: number; reason: string; ms: number }
  /** Stall de lecture observé côté web (note manuelle/auto du pont). */
  | { t: 'stall'; durMs: number; bufferSec?: number }
  /** Erreur de lecture observée côté web (contexte player, message court). */
  | { t: 'playError'; where: string; message: string }
  /** Transition avant-plan / arrière-plan. */
  | { t: 'visibility'; state: MeshVisibility }
  /** Kill-switch appliqué côté client (pause/résumé). */
  | { t: 'kill'; enabled: boolean }
  /** Capacité locale appliquée (test §14). */
  | { t: 'capacity'; cap: 'off' | 'low' | 'normal' }
  /** Erreur interne capturée (le maillon faible d'un test, jamais un rejet). */
  | { t: 'error'; where: string; message: string };

export type MeshTrace = (event: MeshTraceEvent) => void;

/** Traceur de test console : préfixe [mesh-test] exigé par le brief, filtre
 *  facile dans les devtools. Utilisé par poc.ts uniquement quand le POC est
 *  monté (donc jamais en production normale). */
export function consoleMeshTrace(): MeshTrace {
  return (event) => {
    try { console.info('[mesh-test]', JSON.stringify(event)); } catch { /* console absente/bridée */ }
  };
}

// ---------------------------------------------------------------------------
// Collecteur borné (phase canary) : console + buffer pour window.__meshTest.
// ---------------------------------------------------------------------------

export interface CollectedMeshEvent extends Record<string, unknown> {
  t: string;
  /** Horodatage epoch ms (non personnel : horloge locale du testeur). */
  at: number;
  /** Millisecondes depuis l'ouverture du collecteur (timestamp relatif). */
  rel: number;
}

export interface MeshTraceCollectorOptions {
  maxEvents?: number; // défaut 2000 : au-delà, les plus anciens sont écartés (compteur dropped)
  now?: () => number;
  console?: boolean; // défaut true : garde le comportement [mesh-test] console
}

export interface MeshTraceCollector {
  trace: MeshTrace;
  events(): CollectedMeshEvent[];
  dropped(): number;
  size(): number;
  clear(): void;
}

/** Crée un sink qui loggue en console ET conserve les N derniers événements
 *  enrichis (at/rel) pour l'export `window.__meshTest.dump()`. Borné par
 *  construction : jamais de croissance infinie, jamais de secret (voir
 *  assertMeshTracePrivacy, testée en unitaire). */
export function createMeshTraceCollector(options: MeshTraceCollectorOptions = {}): MeshTraceCollector {
  const maxEvents = Math.max(100, Math.min(options.maxEvents ?? 2000, 10000));
  const now = options.now ?? ((): number => Date.now());
  const useConsole = options.console ?? true;
  const t0 = now();
  const buf: CollectedMeshEvent[] = [];
  let dropCount = 0;
  const trace: MeshTrace = (event) => {
    try {
      if (useConsole) console.info('[mesh-test]', JSON.stringify(event));
    } catch { /* console absente/bridée */ }
    try {
      const at = now();
      buf.push({ ...event, at, rel: Math.max(0, at - t0) } as unknown as CollectedMeshEvent);
      if (buf.length > maxEvents) {
        buf.splice(0, buf.length - maxEvents);
        dropCount += 1;
      }
    } catch { /* instrumentation jamais bloquante */ }
  };
  return {
    trace,
    events: () => buf.slice(),
    dropped: () => dropCount,
    size: () => buf.length,
    clear: () => { buf.length = 0; dropCount = 0; },
  };
}

// ---------------------------------------------------------------------------
// Garde-fou anti-fuite (testé en unitaire, réutilisé par mesh-capture/report).
// ---------------------------------------------------------------------------

const FORBIDDEN_KEY_RE = /token|deviceid|devicehash|did\b|email|cookie|grant|secret|password|authorization|set-cookie|x-sig|x-exp|locator|provider|iptv|xtream|stalker|mac\b/i;
const FORBIDDEN_VALUE_RE = /https?:\/\/|wss?:\/\/|x-sig|x-exp|meshToken|DeviceGrant/i;
const CANDIDATE_TYPES = new Set(['host', 'srflx', 'relay', 'prflx', 'unknown']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Vérifie qu'un événement ne contient aucune donnée personnelle / sensible.
 *  Retourne null si propre, sinon une courte description de la fuite (sans
 *  reproduire la valeur). Ne jette jamais. */
export function findMeshTraceLeak(event: unknown): string | null {
  try {
    const seen: unknown[] = [];
    const walk = (node: unknown, path: string): string | null => {
      if (typeof node === 'string') {
        if (FORBIDDEN_VALUE_RE.test(node)) return `valeur suspecte en ${path}`;
        // Adresse ICE complète ? Un type de candidat est court (host/srflx/…),
        // une adresse contient un point ou un deux-points + des chiffres.
        if ((path.endsWith('.local') || path.endsWith('.remote')) && !CANDIDATE_TYPES.has(node)) {
          return `type de candidat inattendu en ${path}`;
        }
        if (/^\d{1,3}(\.\d{1,3}){3}([:/]|$)/.test(node) || /\[?[0-9a-f]*:[0-9a-f:]+/i.test(node) && node.length > 24) {
          return `adresse possible en ${path}`;
        }
        return null;
      }
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
          const hit = walk(node[i], `${path}[${i}]`);
          if (hit) return hit;
        }
        return null;
      }
      if (isPlainObject(node)) {
        if (seen.includes(node)) return null;
        seen.push(node);
        for (const [key, value] of Object.entries(node)) {
          if (FORBIDDEN_KEY_RE.test(key) && key !== 'candidatePair') return `clé interdite ${path}.${key}`;
          // 'url' est interdite partout : aucun événement mesh ne porte d'URL.
          if (key.toLowerCase() === 'url') return `clé interdite ${path}.${key}`;
          const hit = walk(value, path ? `${path}.${key}` : key);
          if (hit) return hit;
        }
      }
      return null;
    };
    return walk(event, '$');
  } catch {
    return null;
  }
}

/** Lève si l'événement fuit (utilisée par les tests + la validation du
 *  collecteur). En production de test, préférer findMeshTraceLeak (non jetant). */
export function assertMeshTracePrivacy(event: unknown): void {
  const leak = findMeshTraceLeak(event);
  if (leak) throw new Error(`fuite télémétrie mesh: ${leak}`);
}

/** Identité interne d'un segment (jamais l'URL) : `swarm8:cc:sn`. */
export function meshSegmentId(swarm8: string, cc: number, sn: number): string {
  return `${swarm8}:${cc}:${sn}`;
}

/** Classe d'appareil NON personnelle à partir d'un userAgent (l'UA n'est
 *  jamais conservée : seule la classe sort). Heuristique volontairement
 *  grossière : desktop / mobile / tv / webview / unknown. */
export function classifyDeviceClass(userAgent: string): MeshDeviceClass {
  try {
    const ua = String(userAgent ?? '');
    if (!ua) return 'unknown';
    if (/Android TV|SmartTV|Smart-TV|TV;| GoogleTV|HbbTV/i.test(ua)) return 'tv';
    if (/; wv\)|;wv\)|WebView|GeckoView/i.test(ua)) return 'webview';
    if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return 'mobile';
    if (/Windows|Macintosh|Mac OS|Linux|X11|CrOS/i.test(ua)) return 'desktop';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Réseau déclaré par le client (vocabulaire contrat, jamais de détail). */
export function sanitizeNetworkType(value: unknown): 'wifi' | 'cellular' | 'wired' | 'unknown' {
  return value === 'wifi' || value === 'cellular' || value === 'wired' ? value : 'unknown';
}
