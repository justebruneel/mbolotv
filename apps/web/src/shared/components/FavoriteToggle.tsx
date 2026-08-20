'use client';

import { FavoriteButton as UiFavoriteButton } from '@mbolo/ui';
import { useFavoritesStore } from '../stores/favorites';

export function FavoriteToggle({ channelId }: { channelId: string }) {
  const isActive = useFavoritesStore((state) => state.ids.includes(channelId));
  const toggle = useFavoritesStore((state) => state.toggle);
  return <UiFavoriteButton isActive={isActive} onToggle={() => toggle(channelId)} />;
}
