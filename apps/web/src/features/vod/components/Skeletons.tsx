'use client';

import { Skeleton } from '@mbolo/ui';

// Squelettes de chargement de la page Films & Séries — remplacent les
// Spinner centrés qui faisaient sauter le layout. Formes exactes des tuiles
// (poster 2:3, miniature 16:9) pour un rendu stable au chargement.
export function SkeletonPosterGrid({ count = 24 }: { count?: number }) {
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8" aria-hidden>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index}>
          <Skeleton className="aspect-[2/3] w-full rounded-xl" />
          <Skeleton className="mt-2 h-3.5 w-3/4 rounded" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonVideoGrid({ count = 20 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5" aria-hidden>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index}>
          <Skeleton className="aspect-video w-full rounded-xl" />
          <Skeleton className="mt-2 h-3.5 w-3/4 rounded" />
        </div>
      ))}
    </div>
  );
}

// Accueil façon Netflix : héros plein écran puis rails — le squelette suit la
// même structure pour éviter tout décalage quand les données arrivent.
export function SkeletonHome() {
  return (
    <div aria-hidden>
      <Skeleton className="aspect-[16/9] w-full rounded-2xl md:aspect-[21/9]" />
      <div className="mt-8 flex items-baseline justify-between">
        <Skeleton className="h-5 w-40 rounded" />
        <Skeleton className="h-4 w-16 rounded" />
      </div>
      <div className="mt-3 flex gap-3 overflow-hidden">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="min-w-[136px] sm:min-w-[152px]">
            <Skeleton className="aspect-[2/3] w-[136px] rounded-xl sm:w-[152px]" />
            <Skeleton className="mt-2 h-3.5 w-3/4 rounded" />
          </div>
        ))}
      </div>
      <div className="mt-8 flex items-baseline justify-between">
        <Skeleton className="h-5 w-44 rounded" />
        <Skeleton className="h-4 w-16 rounded" />
      </div>
      <div className="mt-3 flex gap-3 overflow-hidden">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="min-w-[136px] sm:min-w-[152px]">
            <Skeleton className="aspect-[2/3] w-[136px] rounded-xl sm:w-[152px]" />
            <Skeleton className="mt-2 h-3.5 w-3/4 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}