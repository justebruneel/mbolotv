export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

/**
 * Formate un temps restant en ms en label compact.
 *  - >=2j → "X j"
 *  - 1j → "1 j X h"
 *  - >=1h → "X h MM"
 *  - <1h → "X min"
 * Retourne "expiré" si <=0.
 */
export function formatRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return 'expiré';
  const days = Math.floor(remainingMs / DAY_MS);
  const hours = Math.floor((remainingMs % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((remainingMs % HOUR_MS) / MINUTE_MS);
  if (days >= 2) return `${days} j`;
  if (days === 1) return `1 j ${hours} h`;
  if (hours >= 1) return `${hours} h ${String(minutes).padStart(2, '0')}`;
  return `${minutes} min`;
}

/**
 * Formate une date ISO en chaîne localisée fr-FR.
 * Utilise le même format que AccessTimeBadge (toLocaleString).
 */
export function formatExpiresAt(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR');
}

/**
 * Calcule le label restant à partir d'une date ISO d'expiration.
 * Utile pour la console owner : évite de dupliquer le calcul.
 */
export function formatRemainingFromIso(expiresAt: string | null, now = Date.now()): string | null {
  if (!expiresAt) return null;
  const remaining = new Date(expiresAt).getTime() - now;
  if (remaining <= 0) return 'expiré';
  return formatRemaining(remaining);
}
