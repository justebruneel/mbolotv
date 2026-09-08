'use client';

import type { YoutubeVideo } from '@mbolo/contracts';
import { useSettingsStore } from '../../../shared/stores/settings';
import { youtubeProgressId } from '../../../shared/stores/youtubeFavorites';
import { formatPublishedRelative } from '../../../shared/utils/formatPublishedRelative';
import { MediaTile } from './MediaTile';

// Fiche joignable même si l'API détail est injoignable : la tuile embarque
// titre/affiche/date en params (repli n°3 après API puis cache React Query).
export function youtubeDetailHref(item: Pick<YoutubeVideo, 'id' | 'title' | 'posterUrl' | 'publishedAt'>): string {
  const search = new URLSearchParams();
  search.set('t', item.title.slice(0, 120));
  if (item.posterUrl) search.set('p', item.posterUrl);
  if (item.publishedAt) search.set('pub', item.publishedAt);
  return `/vod/yt/${item.id}?${search.toString()}`;
}

// Tuile miniature 16:9 (YouTube) — même langage que VodTile (2:3 poster) :
// hover play, barre de reprise. Pas de bouton favori sur la carte : il vit
// dans la fiche, à côté du bouton Lecture.
export function YoutubeTile({ item }: { item: YoutubeVideo }) {
  const progressId = youtubeProgressId(item.id);
  const progress = useSettingsStore((state) => state.vodProgress[progressId]);
  const publishedLabel = item.publishedAt ? formatPublishedRelative(item.publishedAt) : null;

  return (
    <MediaTile
      href={youtubeDetailHref(item)}
      ariaLabel={`Ouvrir la fiche de ${item.title}`}
      aspect="video"
      imageUrl={item.posterUrl}
      title={item.title}
      subtitle={publishedLabel}
      progress={progress && progress.duration > 0 ? progress : undefined}
    />
  );
}