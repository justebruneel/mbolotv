'use client';

import { useEffect, useRef, useState } from 'react';

// Défilement infini par sentinelle (IntersectionObserver, marge 600 px) :
// le pattern dupliqué par les grilles VodBrowse/FolderVodBrowse/YoutubeBrowse/
// MergedYoutubeBrowse/ExternalBrowse. Les composants gardent la requête React
// Query pour les données ; le hook ne gère que le pager (page suivante quand
// la sentinelle devient visible, sans double déclenchement pendant une page
// en cours de chargement).
export interface InfiniteScrollRelay {
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  fetchNextPage: () => Promise<unknown>;
}

export interface UseInfiniteScrollResult {
  /** Élément de fin de grille à observer (placer après le <div> de la grille). */
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  /** Une page supplémentaire est en cours de chargement à l'écran. */
  isFetchingNextPage: boolean;
}

export function useInfiniteScroll(query: InfiniteScrollRelay): UseInfiniteScrollResult {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && query.hasNextPage && !query.isFetchingNextPage && !loadingMore) {
          setLoadingMore(true);
          void query.fetchNextPage().finally(() => setLoadingMore(false));
        }
      },
      { rootMargin: '600px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage, loadingMore]);

  return { sentinelRef, isFetchingNextPage: query.isFetchingNextPage ?? false };
}