// Préchauffage du direct : un simple GET du manifest via le proxy vidéo.
// Sous l'architecture edge, monter un hls.js caché ne sert à rien (son buffer
// n'est pas transférable au lecteur) et coûte un aller-retour fournisseur à
// chaque survol. Le fetch léger réchauffe DNS/TLS/HTTP2 navigateur↔proxy et
// proxy↔fournisseur, et valide que le flux répond — y compris sur iOS/Safari
// où hls.js n'est pas supporté.

export interface WarmGuards {
  /** Économie de données navigateur : true = ne jamais préchauffer. */
  saveData: boolean;
  /** Type effectif navigator.connection (slow-2g/2g exclus). */
  effectiveType?: string | null;
  /** Page visible : pas de préchauffage en arrière-plan. */
  visible: boolean;
}

/** Faut-il préchauffer cette URL ? Pure et testée. Règles :
 *  - uniquement les manifests HLS (convention projet `/m3u8/i`, identique au
 *    sélecteur de moteur du Player — un flux TS brut ou un MP4 ne matchent
 *    pas et sont donc exclus du préchauffage) ;
 *  - jamais en économie de données, jamais en arrière-plan, jamais en 2G.
 *  Le coût résiduel est de toute façon borné (timeout + cancel du corps). */
export function shouldWarm(url: string, guards: WarmGuards): boolean {
  try {
    if (typeof url !== 'string' || !url || !/m3u8/i.test(url)) return false;
    if (guards.saveData) return false;
    if (!guards.visible) return false;
    const t = String(guards.effectiveType ?? '').toLowerCase();
    if (t === 'slow-2g' || t === '2g') return false;
    return true;
  } catch {
    return false;
  }
}

let lastWarmedUrl: string | null = null;
let inFlight: Promise<void> | null = null;
let inFlightAbort: AbortController | null = null;

export function warmStream(url: string, opts?: { timeoutMs?: number }): void {
  if (typeof window === 'undefined' || !url) return;
  if (url === lastWarmedUrl || inFlight) return;
  lastWarmedUrl = url;
  const timeoutMs = opts?.timeoutMs && opts.timeoutMs > 0 ? Math.min(opts.timeoutMs, 10_000) : 3000;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  inFlightAbort = controller;
  const timer = window.setTimeout(() => {
    try { controller?.abort(); } catch { /* ignore */ }
  }, timeoutMs);
  const done = (): void => {
    window.clearTimeout(timer);
    inFlight = null;
    if (inFlightAbort === controller) inFlightAbort = null;
  };
  inFlight = fetch(url, { mode: 'cors', cache: 'no-store', signal: controller?.signal })
    .then((response) => {
      // Manifest reçu : la connexion navigateur↔proxy↔fournisseur est chaude.
      // Le corps n'est pas lu intégralement : on annule pour libérer la socket.
      void response.body?.cancel().catch(() => undefined);
    })
    .catch(() => undefined)
    .finally(done);
}

export function cancelWarm(): void {
  lastWarmedUrl = null;
  try { inFlightAbort?.abort(); } catch { /* ignore */ }
  inFlight = null;
  inFlightAbort = null;
}
