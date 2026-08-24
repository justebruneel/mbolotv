// Préchauffage du direct : un simple GET du manifest via le proxy vidéo.
// Sous l'architecture edge, monter un hls.js caché ne sert à rien (son buffer
// n'est pas transférable au lecteur) et coûte un aller-retour fournisseur à
// chaque survol. Le fetch léger réchauffe DNS/TLS/HTTP2 navigateur↔proxy et
// proxy↔fournisseur, et valide que le flux répond — y compris sur iOS/Safari
// où hls.js n'est pas supporté.

let lastWarmedUrl: string | null = null;
let inFlight: Promise<void> | null = null;

export function warmStream(url: string): void {
  if (typeof window === "undefined" || !url) return;
  if (url === lastWarmedUrl || inFlight) return;
  lastWarmedUrl = url;
  inFlight = fetch(url, { mode: "cors", cache: "no-store" })
    .then((response) => {
      // Manifest reçu : la connexion navigateur↔proxy↔fournisseur est chaude.
      // Le corps n'est pas lu intégralement : on annule pour libérer la socket.
      void response.body?.cancel().catch(() => undefined);
    })
    .catch(() => undefined)
    .finally(() => {
      inFlight = null;
    });
}

export function cancelWarm(): void {
  lastWarmedUrl = null;
}
