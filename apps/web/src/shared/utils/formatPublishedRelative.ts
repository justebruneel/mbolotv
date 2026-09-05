import { DAY_MS, HOUR_MS, MINUTE_MS } from './formatDuration';

const DAY_MS_7 = 7 * DAY_MS;

/**
 * Formate une date de publication ISO en label relatif « mise en ligne … » :
 *   - < 1 min   → « mise en ligne à l'instant »
 *   - < 60 min  → « mise en ligne il y a X min »
 *   - < 24 h    → « mise en ligne il y a X h »
 *   - < 7 j     → « mise en ligne il y a X j »
 *   - < 5 sem.  → « mise en ligne il y a X semaine(s) »
 *   - < 1 an    → « mise en ligne il y a X mois »
 *   - au-delà   → « mise en ligne il y a X an(s) »
 * Date invalide → null (l'appelant masque le label).
 */
export function formatPublishedRelative(iso: string, now = Date.now()): string | null {
  const published = new Date(iso).getTime();
  if (!Number.isFinite(published)) return null;
  const delta = Math.max(0, now - published);
  const prefix = 'mise en ligne';
  if (delta < MINUTE_MS) return `${prefix} à l'instant`;
  const minutes = Math.floor(delta / MINUTE_MS);
  if (minutes < 60) return `${prefix} il y a ${minutes} min`;
  const hours = Math.floor(delta / HOUR_MS);
  if (hours < 24) return `${prefix} il y a ${hours} h`;
  const days = Math.floor(delta / DAY_MS);
  if (days < 7) return `${prefix} il y a ${days} j`;
  if (delta < 5 * DAY_MS_7) {
    const weeks = Math.round(days / 7);
    return `${prefix} il y a ${weeks} semaine${weeks > 1 ? 's' : ''}`;
  }
  if (delta < 365 * DAY_MS) {
    const months = Math.max(1, Math.round(days / 30));
    return `${prefix} il y a ${months} mois`;
  }
  const years = Math.floor(delta / (365 * DAY_MS));
  return `${prefix} il y a ${years} an${years > 1 ? 's' : ''}`;
}
