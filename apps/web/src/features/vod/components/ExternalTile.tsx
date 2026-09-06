'use client';

import { Icon } from '@mbolo/ui';
import type { ExternalTitlePublic } from '@mbolo/contracts';
import Link from 'next/link';
import { useState } from 'react';

// Tuile affiche 2:3 des titres externes (lecteurs tiers) — même coquille que
// VodTile, mais lien vers la fiche /vod/x/<id>. Pas de favoris ni reprise v1
// (stores couplés aux ids Xtream ; préfixer en x: si on les branche un jour).
export function ExternalTile({ item }: { item: ExternalTitlePublic }) {
  const [posterError, setPosterError] = useState(false);

  return (
    <article className="group relative min-w-0">
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl border border-border bg-surface transition-[transform,border-color,box-shadow] duration-300 group-hover:-translate-y-1 group-hover:border-accent/50 group-hover:shadow-lg">
        <Link href={`/vod/x/${item.id}`} aria-label={`Ouvrir la fiche de ${item.title}`} className="block h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset">
          {item.posterUrl && !posterError ? (
            <img src={item.posterUrl} alt="" loading="lazy" decoding="async" onError={() => setPosterError(true)} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
          ) : (
            <div className="flex h-full items-center justify-center bg-gradient-to-br from-surface-2 to-surface text-muted/40">
              <Icon.Film size={36} />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
          <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-300 group-hover:opacity-100">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-on-accent shadow-lg transition-transform duration-200 group-hover:scale-110">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            </div>
          </div>
        </Link>
      </div>
      <div className="mt-2 px-0.5">
        <p className="line-clamp-2 text-[13px] font-semibold leading-tight text-foreground transition-colors duration-200 group-hover:text-accent">{item.title}</p>
        {item.year != null && <p className="mt-0.5 truncate text-[11px] text-muted">{item.year}</p>}
      </div>
    </article>
  );
}
