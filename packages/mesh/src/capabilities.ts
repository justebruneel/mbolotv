// Détection de capacité — le POC NE TENTE le P2P que si tout est réellement
// là (MSE + RTCPeerConnection + DataChannel + fetch). Sur les chemins Safari
// natif, mpegts.js et iOS < 17, cette fonction renvoie false : le Player
// conserve son comportement actuel, intact (règle n°2 du brief).
export interface MeshCapabilities {
  mse: boolean;
  rtc: boolean;
  dataChannel: boolean;
  webCrypto: boolean;
  compatible: boolean;
}

export function detectMeshCapabilities(g: {
  MediaSource?: { isSupported?(): boolean } | undefined;
  RTCPeerConnection?: new (config?: RTCConfiguration) => { createDataChannel?: unknown } | undefined;
  RTCDataChannel?: unknown;
  crypto?: Crypto | undefined;
  fetch?: unknown;
} = globalThis as never): MeshCapabilities {
  const mse = Boolean(g.MediaSource && (typeof g.MediaSource.isSupported !== 'function' || g.MediaSource.isSupported()));
  const rtc = typeof g.RTCPeerConnection === 'function';
  const dataChannel = typeof g.RTCDataChannel !== 'undefined' || Boolean(rtc && typeof g.RTCPeerConnection?.prototype?.createDataChannel === 'function');
  const webCrypto = Boolean(g.crypto?.subtle?.digest && typeof g.crypto?.getRandomValues === 'function');
  return { mse, rtc, dataChannel, webCrypto, compatible: mse && rtc && dataChannel && webCrypto && Boolean(g.fetch) };
}

/** Android TV (GeckoView/arm32) et WebView anciennes : POC = OFF par défaut.
 *  Dans la POC, AUCUN appareil n'est seeder par défaut (§39 : consentement
 *  upload). Un appareil de test explicite passe capacity via la config ; ici
 *  on ne renvoie QUE 'off' — la non-montée du seeding est le comportement
 *  garanti par construction, pas une heuristique à deviner. */
export function defaultCapacityFor(userAgent: string, saveData: boolean, type: string): 'off' {
  void userAgent; void saveData; void type;
  return 'off';
}

/** Automatiquement indisponible en arrière-plan (iOS/WebView gel) : le client
 *  s'annonce cap:off dès que la page se cache — pas de seeder forcé (§38). */
export function shouldPauseSeeding(state?: { visibilityState: string; hidden: boolean }): boolean {
  const doc = state ?? (typeof document !== 'undefined' ? { visibilityState: document.visibilityState, hidden: document.hidden } : { visibilityState: 'visible', hidden: false });
  return doc.visibilityState !== 'visible' || doc.hidden;
}
