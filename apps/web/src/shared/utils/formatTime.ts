/** Formatage durée en « H:MM:SS » (ou « M:SS » sous l'heure) — partagé par
 * la page Films & Séries, les fiches VOD/YouTube et la rangée « Reprendre ». */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}