'use client';

import { FavoriteButton, Icon } from '@mbolo/ui';
import type { VodItem } from '@mbolo/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { useVodFavoritesStore } from '../../../shared/stores/vodFavorites';
import { useSettingsStore } from '../../../shared/stores/settings';

// Tuile affiche 2:3 (poster) — contre 4:3 pour les chaînes live : le VOD se
// choisit à l'affiche, le live au logo. La barre de reprise lit vodProgress
// (localStorage) : aucun fetch, le server component n'a rien à fournir.
export function VodTile({ item }: { item: VodItem }) {
  const isFavorite = useVodFavoritesStore((state) => state.ids.includes(item.id));
  const toggle = useVodFavoritesStore((state) => state.toggle);
  const [posterError, setPosterError] = useState(false);
  const progress = useSettingsStore((state) => state.vodProgress[item.id]);

  return (
    <article className="group relative min-w-0">
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl border border-border bg-surface transition-[transform,border-color,box-shadow] duration-300 group-hover:-translate-y-1 group-hover:border-accent/50 group-hover:shadow-lg">
        <Link href={`/vod/${item.id}`} aria-label={`Ouvrir la fiche de ${item.title}`} className="block h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset">
          {item.posterUrl && !posterError ? (
            <img src={item.posterUrl} alt="" loading="lazy" decoding="async" onError={() => setPosterError(true)} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
          ) : (
            <div className="flex h-full items-center justify-center bg-gradient-to-br from-surface-2 to-surface text-muted/40">
              <Icon.Film size={36} />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
          {item.rating !== null && item.rating > 0 && (
            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur">
              <Icon.Star size={10} className="text-accent" /> {item.rating.toFixed(1)}
            </span>
          )}
          {progress && progress.duration > 0 && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
              <div className="h-full bg-accent" style={{ width: `${Math.min(100, (progress.position / progress.duration) * 100)}%` }} />
            </div>
          )}
          <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-300 group-hover:opacity-100">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-on-accent shadow-lg transition-transform duration-200 group-hover:scale-110">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            </div>
          </div>
        </Link>
        <span className="absolute right-2 top-2 z-20" onClick={(event) => event.stopPropagation()}>
          <FavoriteButton
            label={isFavorite ? `Retirer ${item.title} des favoris` : `Ajouter ${item.title} aux favoris`}
            isActive={isFavorite}
            onToggle={() => toggle(item.id)}
          />
        </span>
      </div>
      <div className="mt-2 px-0.5">
        <p className="line-clamp-2 text-[13px] font-semibold leading-tight text-foreground transition-colors duration-200 group-hover:text-accent">{item.title}</p>
        {item.category && <p className="mt-0.5 truncate text-[11px] text-muted">{item.category}</p>}
      </div>
    </article>
  );
}
