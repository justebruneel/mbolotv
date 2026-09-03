'use client';

import { FavoriteButton, Icon } from '@mbolo/ui';
import type { YoutubeVideo } from '@mbolo/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { useYoutubeFavoritesStore, youtubeProgressId } from '../../../shared/stores/youtubeFavorites';
import { useSettingsStore } from '../../../shared/stores/settings';

// Tuile affiche 16:9 (miniature YouTube) — même langage que VodTile
// (2:3 poster) : hover play, favori local, barre de reprise.
export function YoutubeTile({ item }: { item: YoutubeVideo }) {
  const progressId = youtubeProgressId(item.id);
  const isFavorite = useYoutubeFavoritesStore((state) => state.ids.includes(progressId));
  const toggle = useYoutubeFavoritesStore((state) => state.toggle);
  const [posterError, setPosterError] = useState(false);
  const progress = useSettingsStore((state) => state.vodProgress[progressId]);

  return (
    <article className="group relative min-w-0">
      <div className="relative aspect-video overflow-hidden rounded-xl border border-border bg-surface transition-[transform,border-color,box-shadow] duration-300 group-hover:-translate-y-1 group-hover:border-accent/50 group-hover:shadow-lg">
        <Link href={`/vod/yt/${item.id}`} aria-label={`Ouvrir la fiche de ${item.title}`} className="block h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset">
          {item.posterUrl && !posterError ? (
            <img src={item.posterUrl} alt="" loading="lazy" decoding="async" onError={() => setPosterError(true)} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
          ) : (
            <div className="flex h-full items-center justify-center bg-gradient-to-br from-surface-2 to-surface text-muted/40">
              <Icon.Film size={36} />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
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
            onToggle={() => toggle(progressId)}
          />
        </span>
      </div>
      <div className="mt-2 px-0.5">
        <p className="line-clamp-2 text-[13px] font-semibold leading-tight text-foreground transition-colors duration-200 group-hover:text-accent">{item.title}</p>
        {item.publishedAt && <p className="mt-0.5 truncate text-[11px] text-muted">{new Date(item.publishedAt).toLocaleDateString('fr-FR')}</p>}
      </div>
    </article>
  );
}
