'use client';
// Pont POC MeshStream côté web (ADR-0004 étape 4).
//
// Triple condition AVANT toute création de session (règle n°1 — le P2P est
// impossible à activer accidentellement, §32 du brief) :
//   1. NEXT_PUBLIC_MESH_POC=1           (flag de build — éteint en production)
//   2. /play a renvoyé p2p:true + jeton (autorisation SERVEUR, DeviceGrant)
//   3. capabilities réelles             (MSE + hls.js-path + WebRTC + DataChannel)
// Plus : du code du package @mbolo/mesh n'est MÊME TÉLÉCHARGÉ sans ces
// conditions (import dynamique — le bundle du chemin actuel ne change pas).
//
// Consentement upload (§39) : le seeding est TOUJOURS 'off' par défaut ; un
// appareil de test l'active explicitement via localStorage `mbolo:mesh-cap`
// (= 'low' | 'normal'). Consommer ne demande aucun consentement : un pair
// 'off' rejoint le swarm pour RECEVOIR — jamais pour servir.
import type { PlayResponse } from '@mbolo/contracts';
import type { MeshSession } from '@mbolo/mesh';

const POC_FLAG = process.env.NEXT_PUBLIC_MESH_POC === '1';
const STUN_LIST = (process.env.NEXT_PUBLIC_MESH_STUN ?? 'stun:stun.l.google.com:19302')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean)
  .map((urls) => ({ urls }));

const CAP_KEY = 'mbolo:mesh-cap';

export function meshPocEnabled(): boolean { return POC_FLAG; }

/** Capacité de seeding CONSENTIE par cet appareil (défaut : off — jamais un
 *  seurs forcé, §39). Seul l'opérateur d'un appareil de test pose la clé. */
export function consentedCapacity(): 'off' | 'low' | 'normal' {
  try {
    const raw = window.localStorage.getItem(CAP_KEY);
    return raw === 'normal' || raw === 'low' ? raw : 'off';
  } catch { return 'off'; }
}

function networkType(): 'wifi' | 'cellular' | 'wired' | 'unknown' {
  const conn = (navigator as { connection?: { type?: string; saveData?: boolean } }).connection;
  if (conn?.type === 'cellular') return 'cellular';
  if (conn?.type === 'wifi' || conn?.type === 'ethernet') return conn.type === 'ethernet' ? 'wired' : 'wifi';
  return 'unknown';
}

/** Capacité EFFECTIVE = consentement plafonné par le réseau et l'économie de
 *  données (§19 brief : cellulaire → off/low, Wi-Fi+écran actif → normal).
 *  On ne force JAMAIS l'utilisateur à uploader : le plafond ne fait que
 *  DESCENDRE sous le consentement, jamais monter au-dessus. `saveData` (bascule
 *  économie de données du navigateur) coupe complètement l'upload. */
export function effectiveCapacity(consent: 'off' | 'low' | 'normal', type: 'wifi' | 'cellular' | 'wired' | 'unknown', saveData: boolean, visible: boolean): 'off' | 'low' | 'normal' {
  if (!visible) return 'off';            // arrière-plan : jamais seeder (§38, page cachée = pas d'upload)
  if (saveData) return 'off';            // l'utilisateur a demandé d'économiser les données
  if (consent === 'off') return 'off';   // refus de consentement : on ne sert RIEN (mais on peut RECEVOIR)
  if (type === 'cellular') return 'low'; // cellulaire : plafond bas même si consenti normal
  return consent;                        // wifi/wired/unknown : le consentement s'applique tel quel
}

export interface MeshBridge {
  session: MeshSession | null;
  dispose(): void;
}

/** saveData du navigateur (économie de données activée) : coupe l'upload. */
function saveDataEnabled(): boolean {
  return Boolean((navigator as { connection?: { saveData?: boolean } }).connection?.saveData);
}

/** Classe d'appareil non personnelle (l'UA n'est jamais conservée). */
function deviceClass(): 'desktop' | 'mobile' | 'tv' | 'webview' | 'unknown' {
  try {
    const ua = navigator.userAgent ?? '';
    if (!ua) return 'unknown';
    if (/Android TV|SmartTV|Smart-TV| GoogleTV|HbbTV/i.test(ua)) return 'tv';
    if (/; wv\)|WebView|GeckoView/i.test(ua)) return 'webview';
    if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return 'mobile';
    if (/Windows|Macintosh|Mac OS|Linux|X11|CrOS/i.test(ua)) return 'desktop';
    return 'unknown';
  } catch { return 'unknown'; }
}

/** Expose un utilitaire de test (uniquement quand le POC est monté) :
 *  `window.__meshTest.dump()` renvoie le rapport §11/§21 (compteurs, peerRatio,
 *  offload) + les événements trace bornés SANS aucun secret (ni token, ni IP,
 *  ni URL fournisseur). Absent en production normale : cette fonction n'est
 *  jamais appelée (garde POC_FLAG).
 *  `noteStall(durMs)` / `noteError(where, message)` permettent au testeur (ou
 *  à un futur pont Player opt-in) d'annoter stalls/erreurs de lecture.
 *  `export()` télécharge le JSON à transmettre au responsable du test. */
function exposeMeshTest(
  session: MeshSession,
  collector: { trace: (e: never) => void; events: () => unknown[]; dropped: () => number },
  meta: { deviceClass: string; provenance: string; startedAt: string },
): void {
  try {
    const w = window as unknown as { __meshTest?: unknown };
    w.__meshTest = {
      dump: () => ({
        v: 1,
        provenance: meta.provenance,
        deviceClass: meta.deviceClass,
        startedAt: meta.startedAt,
        swarm: session.swarmLabel,
        peer: (session as unknown as { peerLabel?: string }).peerLabel ?? null,
        ...session.stats,
        peerHitRate: session.peerHitRate(),
        meshOffload: session.meshOffload(),
        dropped: collector.dropped(),
        events: collector.events(),
      }),
      events: () => collector.events(),
      noteStall: (durMs: number, bufferSec?: number) => {
        try { collector.trace({ t: 'stall', durMs: Math.max(0, Math.round(Number(durMs) || 0)), ...(bufferSec === undefined ? {} : { bufferSec: Math.max(0, Number(bufferSec) || 0) }) } as never); } catch { /* no-op */ }
      },
      noteError: (where: string, message: string) => {
        try { collector.trace({ t: 'playError', where: String(where).slice(0, 64), message: String(message).slice(0, 200) } as never); } catch { /* no-op */ }
      },
      export: () => {
        try {
          const payload = JSON.stringify((w.__meshTest as { dump: () => unknown }).dump(), null, 2);
          const blob = new Blob([payload], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `mesh-dump-${session.swarmLabel}-${Date.now()}.json`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        } catch { /* no-op */ }
      },
    };
  } catch { /* environnement sans window : rien à exposer */ }
}
export async function createMeshBridge(data: PlayResponse | undefined): Promise<MeshBridge> {
  if (!POC_FLAG || !data?.p2p || !data.meshToken || !data.meshUrl) return { session: null, dispose() {} };
  let session: MeshSession | null = null;
  let collector: { trace: (e: never) => void; events: () => unknown[]; dropped: () => number } | null = null;
  try {
    const { createMeshSession, detectMeshCapabilities, createMeshTraceCollector, MESH_PROTOCOL_VERSION } = await import('@mbolo/mesh');
    if (!detectMeshCapabilities().compatible) return { session: null, dispose() {} }; // mpegts.js/Safari natif/iOS ancien : jamais ici de toute façon (garde Player), mais doublé
    // Collecteur borné canary : console [mesh-test] + buffer exportable.
    collector = createMeshTraceCollector({ maxEvents: 2000, console: true });
    const net = networkType();
    const visible = typeof document === 'undefined' ? true : !document.hidden;
    const cap = effectiveCapacity(consentedCapacity(), net, saveDataEnabled(), visible);
    session = createMeshSession({
      token: data.meshToken,
      meshUrl: data.meshUrl,
      capacity: cap,
      networkType: net,
      iceServers: STUN_LIST, // STUN seul (configurable) ; AUCUN TURN à cette étape (§7 brief)
      // Instrumentation [mesh-test] (§8 + canary) : uniquement ici, dans le POC monté.
      // Chaque événement structuré (ICE/DataChannel/sélection/tier/durées,
      // transferts corrélés tid, fallbacks, dcStats) est loggé avec le préfixe
      // demandé et stocké dans un buffer consultable via window.__meshTest.dump().
      // AUCUN secret/IP/URL fournisseur n'y figure.
      trace: collector.trace as never,
    });
    // Événement d'ouverture de session (reconstruction A↔B sans données
    // personnelles : sid8 + pid éphémère + classe d'appareil générique).
    try {
      const s = session as unknown as { swarmLabel: string; peerLabel?: string } | null;
      collector.trace({
        t: 'session', sid8: s?.swarmLabel ?? 'unknown', pid: s?.peerLabel ?? 'unknown',
        proto: (MESH_PROTOCOL_VERSION as number) ?? 1, cap, net,
        deviceClass: deviceClass(), visibility: visible ? 'foreground' : 'background', peers: 0,
      } as never);
    } catch { /* instrumentation jamais bloquante */ }
  } catch {
    return { session: null, dispose() {} }; // l'échec du mesh ne doit RIEN changer à la lecture
  }
  if (!session || !collector) return { session: null, dispose() {} };
  const live = session;
  const liveCollector = collector;
  exposeMeshTest(live, liveCollector, { deviceClass: deviceClass(), provenance: 'real-device', startedAt: new Date().toISOString() }); // [mesh-test] — window.__meshTest.dump() (test-only, derrière POC_FLAG)
  // §38 : arrière-plan = pas de seeder forcé. La page cachée coupe le seeding
  // (cap→off), le retour le rend selon le CONSENTEMENT plafonné par le réseau
  // (§19) et republie la fenêtre SANS attendre le battement de 30 s. (iOS/
  // WebView gèlent WS/WebRTC de toute façon ; ceci rend l'état honnête côté swarm.)
  const applyCapacity = (): void => {
    try { live.setCapacity(effectiveCapacity(consentedCapacity(), networkType(), saveDataEnabled(), !document.hidden)); } catch { /* mesh déjà mort : irrelevant */ }
  };
  const onVisibility = (): void => {
    try { liveCollector.trace({ t: 'visibility', state: document.hidden ? 'background' : 'foreground' } as never); } catch { /* no-op */ }
    applyCapacity();
    if (!document.hidden) { try { live.republish(); } catch { /* ignore */ } } // sortie d'arrière-plan : redemande à servir aussitôt
  };
  document.addEventListener('visibilitychange', onVisibility);
  return {
    session: live,
    dispose(): void {
      document.removeEventListener('visibilitychange', onVisibility);
      try { live.dispose(); } catch { /* déjà démonter */ }
    },
  };
}
