'use client';

import { Icon } from '@mbolo/ui';
import Link from 'next/link';
import { ReactNode, useEffect, useState } from 'react';

// Tuile média unique pour les grilles : poster 2:3 (films/séries, titres
// Mbolo TV) ou miniature 16:9 (YouTube). Coquille partagée — hover-play,
// dégradé bas, badge facultatif (note), barre de reprise, repli icône Film
// quand l'image échoue. VodTile/YoutubeTile/la tuile externe des Favoris ne
// dupliquent plus ce shell (rendez-vous : une seule sémantique focus/hover).
export interface MediaTileProgress { position: number; duration: number; }

export function MediaTile({
  href,
  ariaLabel,
  aspect,
  imageUrl,
  title,
  subtitle,
  badge,
  progress,
}: {
  href: string;
  ariaLabel: string;
  aspect: 'poster' | 'video';
  imageUrl: string | null;
  title: string;
  subtitle?: string | null;
  badge?: ReactNode;
  progress?: MediaTileProgress | null;
}) {
  const [imageError, setImageError] = useState(false);

  // Une nouvelle affiche (id qui bascule) relance le chargement : l'erreur
  // précédente ne doit pas rester affichée.
  useEffect(() => setImageError(false), [imageUrl]);

  return (
    <article className="group relative min-w-0">
      <div className={`relative overflow-hidden rounded-xl border border-border bg-surface transition-[transform,border-color,box-shadow] duration-300 group-hover:-translate-y-1 group-hover:border-accent/50 group-hover:shadow-lg ${aspect === 'poster' ? 'aspect-[2/3]' : 'aspect-video'}`}>
        <Link href={href} aria-label={ariaLabel} className="block h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset">
          {imageUrl && !imageError ? (
            <img src={imageUrl} alt="" loading="lazy" decoding="async" onError={() => setImageError(true)} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
          ) : (
            <div className="flex h-full items-center justify-center bg-gradient-to-br from-surface-2 to-surface text-muted/40">
              <Icon.Film size={36} />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
          {badge && <span className="absolute left-2 top-2">{badge}</span>}
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
      </div>
      <div className="mt-2 px-0.5">
        <p className="line-clamp-2 text-[13px] font-semibold leading-tight text-foreground transition-colors duration-200 group-hover:text-accent">{title}</p>
        {subtitle && <p className="mt-0.5 truncate text-[11px] text-muted">{subtitle}</p>}
      </div>
    </article>
  );
}