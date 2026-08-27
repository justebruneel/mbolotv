'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../../shared/api/client';
import { Icon } from '@mbolo/ui';

interface FeaturedItem {
  channelId: string;
  programme: {
    id?: string;
    channelId: string;
    title: string;
    description: string | null;
    startsAt: string;
    endsAt: string;
    imageUrl: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    trailerUrl?: string | null;
    genres?: string[] | null;
    type?: string | null;
    year?: number | null;
  };
  channel?: { id: string; name: string; logoUrl: string | null };
}

export function FeaturedAuto() {
  const query = useQuery({
    queryKey: ['featured-auto'],
    queryFn: () => apiGet<FeaturedItem[]>('/epg/featured'),
    staleTime: 5 * 60_000,
  });

  if (query.isLoading) {
    return (
      <div className="mx-4 md:mx-10 h-64 animate-pulse rounded-2xl bg-surface" />
    );
  }
  if (!query.data || query.data.length === 0) return null;
  const item = query.data[0];
  const prog = item.programme;
  const backdrop = (prog as unknown as { backdropUrl?: string | null })?.backdropUrl ?? prog.imageUrl ?? null;
  const poster = (prog as unknown as { posterUrl?: string | null })?.posterUrl ?? null;
  const trailer = (prog as unknown as { trailerUrl?: string | null })?.trailerUrl ?? null;
  const channelName = item.channel?.name ?? 'Mbolo TV';

  return (
    <section className="relative mx-4 md:mx-10 overflow-hidden rounded-2xl border border-border bg-black">
      {backdrop ? (
        <img src={backdrop} alt="" className="absolute inset-0 h-full w-full object-cover opacity-60" loading="lazy" decoding="async" />
      ) : poster ? (
        <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" loading="lazy" decoding="async" />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-surface-3 to-bg" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-transparent to-transparent" />
      <div className="relative p-6 md:p-10 md:pr-[40%]">
        <p className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-widest text-accent">
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent" /> À la une · Ce soir à {new Date(prog.startsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
          {prog.type && <span className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] text-white">{prog.type}</span>}
        </p>
        <h2 className="mt-3 line-clamp-2 text-2xl font-black leading-tight text-white md:text-4xl">{prog.title}</h2>
        {prog.description && <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-white/80 md:text-base">{prog.description}</p>}
        {(prog as unknown as { genres?: string[] })?.genres && (
          <p className="mt-1 text-xs text-white/60">{(prog as unknown as { genres: string[] }).genres.slice(0, 3).join(' · ')}</p>
        )}
        <p className="mt-1 text-xs text-white/60">{channelName} · {new Date(prog.startsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} – {new Date(prog.endsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href={`/watch/${item.channelId}`} className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-black text-black shadow-lg hover:bg-white/90">
            <Icon.Play size={16} aria-hidden /> Voir
          </Link>
          <Link href={`/watch/${item.channelId}`} className="inline-flex items-center gap-2 rounded-full bg-white/15 px-6 py-3 text-sm font-bold text-white backdrop-blur hover:bg-white/25">
            Plus d'infos
          </Link>
          {trailer && (
            <a href={trailer} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full bg-danger px-6 py-3 text-sm font-bold text-white hover:bg-danger/90">
              <Icon.Play size={14} aria-hidden /> Bande-annonce
            </a>
          )}
        </div>
        <p className="mt-4 text-[10px] text-white/40">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
      </div>
    </section>
  );
}
