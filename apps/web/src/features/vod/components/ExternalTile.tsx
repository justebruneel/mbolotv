'use client';

import type { ExternalTitlePublic } from '@mbolo/contracts';
import { MediaTile } from './MediaTile';

// Tuile affiche 2:3 des titres externes (lecteurs tiers) — lien vers la fiche
// /vod/x/<id>. Coquille partagée MediaTile (hover-play, dégradé bas, repli
// icône Film) — pas de favoris ni reprise v1 (stores couplés aux ids Xtream).
export function ExternalTile({ item }: { item: ExternalTitlePublic }) {
  return (
    <MediaTile
      href={`/vod/x/${item.id}`}
      ariaLabel={`Ouvrir la fiche de ${item.title}`}
      aspect="poster"
      imageUrl={item.posterUrl}
      title={item.title}
      subtitle={item.year != null ? String(item.year) : null}
    />
  );
}