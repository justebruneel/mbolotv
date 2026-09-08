'use client';

import { Icon } from '@mbolo/ui';
import type { VodItem } from '@mbolo/contracts';
import { useSettingsStore } from '../../../shared/stores/settings';
import { MediaTile } from './MediaTile';

// Tuile affiche 2:3 (poster) — contre 4:3 pour les chaînes live : le VOD se
// choisit à l'affiche, le live au logo. La barre de reprise lit vodProgress
// (localStorage) : aucun fetch, le server component n'a rien à fournir.
// Pas de bouton favori sur la carte : il vit dans la fiche, à côté du bouton
// Lecture (les rails/grilles ne doivent pas être parsées de cœurs).
export function VodTile({ item }: { item: VodItem }) {
  const progress = useSettingsStore((state) => state.vodProgress[item.id]);

  return (
    <MediaTile
      href={`/vod/${item.id}`}
      ariaLabel={`Ouvrir la fiche de ${item.title}`}
      aspect="poster"
      imageUrl={item.posterUrl}
      title={item.title}
      subtitle={item.category}
      badge={
        item.rating !== null && item.rating > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur">
            <Icon.Star size={10} className="text-accent" /> {item.rating.toFixed(1)}
          </span>
        ) : undefined
      }
      progress={progress && progress.duration > 0 ? progress : undefined}
    />
  );
}