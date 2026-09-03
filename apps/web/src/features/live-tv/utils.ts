import type { Category } from '@mbolo/contracts';

export function isBouquetCategory(name: string): boolean {
  return name.includes('|');
}

export function formatCategoryName(name: string): string {
  const segments = name.split('|');
  const main =
    segments.length >= 3
      ? (segments[2] ?? '').trim()
      : segments.length === 2
        ? (segments[1] ?? '').trim()
        : name.trim();
  return main
    .replace(/^✪\s*/, '')
    .replace(/\s*ᵁᴴᴰ\/ᴴᴰ\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function channelInitials(name: string): string {
  const cleaned = name
    .replace(/^[A-ZÀ-Ý]{2,3}\s*[-–]\s*/i, '')
    .split('|')[0]
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 2);
  return words.map((word) => word[0]?.toUpperCase()).join('') || '?';
}

// Fond déterministe du monogramme de secours (logo indisponible) : même
// teinte pour une même chaîne entre deux rendus, sans dépendance réseau.
export function channelMonogramStyle(name: string): { background: string } {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return { background: `linear-gradient(135deg, hsl(${hue} 45% 28%), hsl(${(hue + 40) % 360} 50% 16%))` };
}

export function channelBadge(name: string): string | null {
  if (/^VIP\b/i.test(name.trim())) return 'VIP';
  const quality = name.match(/\b(FHD|UHD|4K|HD)\b/i);
  return quality ? quality[1].toUpperCase() : null;
}

export function categoryLabel(categories: Category[], slug?: string): string | undefined {
  if (!slug) return undefined;
  return categories.find((category) => category.slug === slug)?.name;
}

export interface WatchContext {
  category?: string;
  country?: string;
  q?: string;
}

export function buildWatchHref(channelId: string, context?: WatchContext): string {
  const params = new URLSearchParams();
  if (context?.category) params.set('category', context.category);
  if (context?.country) params.set('country', context.country);
  if (context?.q?.trim()) params.set('q', context.q.trim());
  const query = params.toString();
  return query ? `/watch/${channelId}?${query}` : `/watch/${channelId}`;
}
