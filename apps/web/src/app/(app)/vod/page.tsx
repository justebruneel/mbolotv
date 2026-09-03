'use client';

import { EmptyState, Icon, Spinner } from '@mbolo/ui';
import type { VodKind } from '@mbolo/contracts';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { YOUTUBE_AFOREVO_CHANNEL_ID, useInfiniteVod, useInfiniteYoutube, useVodCategories } from '../../../shared/api/queries';
import { VodTile } from '../../../features/vod/components/VodTile';
import { YoutubeTile } from '../../../features/vod/components/YoutubeTile';
import { useSettingsStore } from '../../../shared/stores/settings';
const PAGE_SIZE = 48;
type Tab = 'MOVIE' | 'SERIES' | 'NOLLYWOOD';

function isVodKind(value: string | null): value is Tab {
  return value === 'MOVIE' || value === 'SERIES' || value === 'NOLLYWOOD';
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function ResumeRow() {
  const vodProgress = useSettingsStore((state) => state.vodProgress);
  const entries = useMemo(
    () => Object.values(vodProgress).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 12),
    [vodProgress],
  );
  if (entries.length === 0) return null;
  return (
    <section aria-label="Reprendre la lecture" className="mb-8">
      <h2 className="mb-3 text-lg font-bold">Reprendre</h2>
      <div className="flex gap-3 overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {entries.map((entry) => (
          <a key={entry.id} href={entry.id.startsWith('yt:') ? `/vod/yt/${entry.id.slice(3)}` : `/vod/${entry.id}`} className="group relative w-[136px] shrink-0">
            <div className="relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-surface">
              {entry.posterUrl ? (
                <img src={entry.posterUrl} alt="" loading="lazy" className="h-full w-full object-cover transition group-hover:scale-105" />
              ) : (
                <div className="flex h-full items-center justify-center text-muted"><Icon.Film size={28} /></div>
              )}
              <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50"><div className="h-full bg-accent" style={{ width: `${Math.min(100, (entry.position / Math.max(1, entry.duration)) * 100)}%` }} /></div>
            </div>
            <p className="mt-1.5 truncate text-sm font-semibold">{entry.title}</p>
            <p className="text-xs text-muted">{formatTime(entry.position)} / {formatTime(entry.duration)}</p>
          </a>
        ))}
      </div>
    </section>
  );
}

function VodBrowse({ kind, category, q }: { kind: VodKind; category: string | null; q: string }) {
  const query = useInfiniteVod({ kind, category: category ?? undefined, q: q || undefined }, PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && query.hasNextPage && !query.isFetchingNextPage && !loadingMore) {
        setLoadingMore(true);
        void query.fetchNextPage().finally(() => setLoadingMore(false));
      }
    }, { rootMargin: '600px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage, loadingMore]);

  if (query.isLoading) return <div className="flex justify-center py-16"><Spinner /></div>;
  if (query.isError) return <EmptyState title="Catalogue indisponible" hint="Réessayez dans quelques instants." />;
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  if (items.length === 0) return <EmptyState title="Aucun résultat" hint={q ? `Aucun titre ne correspond à « ${q} ».` : 'Ce catalogue est vide pour le moment.'} />;

  return (
    <>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {items.map((item) => <VodTile key={item.id} item={item} />)}
      </div>
      <div ref={sentinelRef} className="h-10" />
      {query.isFetchingNextPage && <div className="flex justify-center py-4"><Spinner /></div>}
    </>
  );
}

function YoutubeBrowse({ q }: { q: string }) {
  const query = useInfiniteYoutube(YOUTUBE_AFOREVO_CHANNEL_ID, 25);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && query.hasNextPage && !query.isFetchingNextPage && !loadingMore) {
        setLoadingMore(true);
        void query.fetchNextPage().finally(() => setLoadingMore(false));
      }
    }, { rootMargin: '600px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage, loadingMore]);

  if (query.isLoading) return <div className="flex justify-center py-16"><Spinner /></div>;
  if (query.isError) return <EmptyState title="Catalogue indisponible" hint="Réessayez dans quelques instants." />;
  // Recherche locale sur les pages chargées (pas de search YouTube : 100 unités
  // de quota par appel — la recherche serveur reste sur le catalogue Xtream).
  const needle = q.trim().toLowerCase();
  const items = (query.data?.pages.flatMap((page) => page.items) ?? [])
    .filter((item) => needle === '' || item.title.toLowerCase().includes(needle));
  if (items.length === 0) return <EmptyState title="Aucun résultat" hint={q ? `Aucun titre ne correspond à « ${q} ».` : 'Ce catalogue est vide pour le moment.'} />;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {items.map((item) => <YoutubeTile key={item.id} item={item} />)}
      </div>
      <div ref={sentinelRef} className="h-10" />
      {query.isFetchingNextPage && <div className="flex justify-center py-4"><Spinner /></div>}
    </>
  );
}

function VodPageContent() {
  const searchParams = useSearchParams();
  const q = searchParams.get('q') ?? '';
  // Onglet actif : ?kind= (Films par défaut). L'URL fait foi pour les liens
  // directs et le retour navigateur — pas d'état persisté superflu.
  const [tab, setTab] = useState<Tab>(() => {
    const value = searchParams.get('kind');
    return isVodKind(value) ? value : 'MOVIE';
  });
  const [category, setCategory] = useState<string | null>(null);

  const kindParam = searchParams.get('kind');
  useEffect(() => { if (isVodKind(kindParam)) setTab(kindParam); }, [kindParam]);
  useEffect(() => { setCategory(null); }, [tab]);

  const categories = useVodCategories(tab === 'NOLLYWOOD' ? undefined : tab);

  const switchTab = (next: Tab): void => {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set('kind', next);
    window.history.replaceState(null, '', url.toString());
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2" role="tablist" aria-label="Type de contenu">
          {(['MOVIE', 'SERIES', 'NOLLYWOOD'] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => switchTab(value)}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${tab === value ? 'bg-accent text-white' : 'bg-surface text-muted hover:text-text'}`}>
              {value === 'MOVIE' ? 'Films' : value === 'SERIES' ? 'Séries' : 'Nollywood'}
            </button>
          ))}
        </div>
      </div>
      {!q && <ResumeRow />}
      {tab !== 'NOLLYWOOD' && categories.data && categories.data.length > 1 && (
        <div className="mb-5 flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button type="button" onClick={() => setCategory(null)}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${category === null ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:text-text'}`}>
            Tout
          </button>
          {categories.data.map((entry) => (
            <button key={entry.name} type="button" onClick={() => setCategory(category === entry.name ? null : entry.name)}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${category === entry.name ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:text-text'}`}>
              {entry.name} <span className="opacity-60">{entry.count}</span>
            </button>
          ))}
        </div>
      )}
      <Suspense fallback={<div className="flex justify-center py-16"><Spinner /></div>}>
        {tab === 'NOLLYWOOD' ? <YoutubeBrowse q={q} /> : <VodBrowse kind={tab} category={category} q={q} />}
      </Suspense>
    </div>
  );
}

export default function VodPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-16"><Spinner /></div>}>
      <VodPageContent />
    </Suspense>
  );
}
