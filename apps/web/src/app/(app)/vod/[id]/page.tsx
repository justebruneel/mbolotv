'use client';

import { EmptyState, Icon, Spinner } from '@mbolo/ui';
import { useParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useVodEpisodes, useVodItem } from '../../../../shared/api/queries';
import { useVodPlayerStore } from '../../../../shared/stores/player';
import { useVodFavoritesStore } from '../../../../shared/stores/vodFavorites';
import { useSettingsStore } from '../../../../shared/stores/settings';
import { FavoriteButton } from '@mbolo/ui';

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

// Fiche façon Netflix : backdrop 16:9 plein cadre (affiche TMDB haute
// résolution, dégradés vers le bas et vers la droite), titre + métadonnées
// incrustés en bas, gros bouton Lecture. Sous le hero : affiche 2:3 et
// épisodes en liste verticale large (numéro, titre, play) — pas de grille
// compacte : Netflix empile les épisodes en pleine largeur.
function VodDetailContent() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const itemQuery = useVodItem(id, Boolean(id));
  const isSeries = itemQuery.data?.kind === 'SERIES';
  const episodesQuery = useVodEpisodes(id, Boolean(id) && Boolean(isSeries));

  const setVodSource = useVodPlayerStore((state) => state.setVodSource);
  const setVodEpisode = useVodPlayerStore((state) => state.setVodEpisode);
  const storeVodSeason = useVodPlayerStore((state) => state.season);
  const storeVodEpisode = useVodPlayerStore((state) => state.episode);
  const isFavorite = useVodFavoritesStore((state) => state.ids.includes(id));
  const toggleFavorite = useVodFavoritesStore((state) => state.toggle);
  const progress = useSettingsStore((state) => state.vodProgress[id]);

  // Saisons avec épisodes réellement listés (certains panels déclarent une
  // saison vide) ; défaut : saison/épisode 1 jouables, sinon les premiers.
  const seasons = useMemo(
    () => (episodesQuery.data?.seasons ?? []).filter((season) => season.episodes.length > 0),
    [episodesQuery.data],
  );
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const activeSeason = selectedSeason ?? seasons[0]?.number ?? null;
  const seasonData = seasons.find((season) => season.number === activeSeason) ?? null;

  // Reprise de série : au premier chargement des épisodes, si le store ne
  // pointe sur aucun épisode de cette série, reprendre là où la lecture
  // s'était arrêtée (progress) sinon le premier épisode de la 1re saison.
  useEffect(() => {
    if (!isSeries || !id || seasons.length === 0) return;
    const inStore = seasons.some((season) => season.number === storeVodSeason && season.episodes.some((episode) => episode.num === storeVodEpisode));
    if (inStore) return;
    const resumeSeason = progress && progress.position > 30 && progress.duration > 0 ? storeVodSeason || seasons[0].number : seasons[0].number;
    const seasonEntry = seasons.find((season) => season.number === resumeSeason) ?? seasons[0];
    const resumeEpisode = seasonEntry.episodes[0];
    if (resumeEpisode) setVodEpisode(seasonEntry.number, resumeEpisode.num);
  }, [isSeries, id, seasons, storeVodSeason, storeVodEpisode, progress, setVodEpisode]);

  const startAt = useMemo(() => {
    // Départ : dernier épisode entamé (position>0) de la série, sinon 1er.
    if (!isSeries) return undefined;
    const seasonEntry = seasons.find((season) => season.number === storeVodSeason);
    return seasonEntry?.episodes.find((episode) => episode.num === storeVodEpisode);
  }, [isSeries, seasons, storeVodSeason, storeVodEpisode]);

  if (!id) return <EmptyState title="Contenu introuvable" />;
  if (itemQuery.isLoading) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (itemQuery.isError || !itemQuery.data) return <EmptyState title="Contenu introuvable" hint="Ce film ou cette série n'est plus disponible." />;

  const item = itemQuery.data;
  const backdropUrl = item.posterUrl?.replace(/w600_and_h900[^/]*\//, 'w1280_and_h720_bestv2/');
  const resumePct = progress && progress.duration > 0 && progress.position > 30
    ? Math.min(100, Math.round((progress.position / progress.duration) * 100))
    : null;

  return (
    <div className="pb-10">
      {/* Hero Netflix : backdrop plein cadre, dégradés, titre + actions. */}
      <section className="relative -mt-px h-[340px] sm:h-[400px] md:h-[480px]">
        {backdropUrl ? (
          <img src={backdropUrl} alt="" className="absolute inset-0 h-full w-full object-cover object-top opacity-85" />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-surface-2 to-surface" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[#0b0b0f] via-black/50 to-black/10" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/20 to-transparent" />

        <div className="absolute inset-x-0 bottom-0 mx-auto w-full max-w-6xl px-4 pb-6 md:pb-8">
          <div className="flex flex-wrap items-center gap-2 text-xs text-white/80">
            <span className="rounded bg-white/15 px-2 py-0.5 font-bold uppercase tracking-wide backdrop-blur">{isSeries ? 'Série' : 'Film'}</span>
            {item.rating !== null && item.rating > 0 && (
              <span className="inline-flex items-center gap-1 font-bold text-accent"><Icon.Star size={12} /> {item.rating.toFixed(1)}</span>
            )}
            {item.category && <span className="max-w-[18rem] truncate">{item.category}</span>}
            {item.addedAt && <span className="hidden sm:inline">{new Date(item.addedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}</span>}
          </div>
          <h1 className="mt-2 max-w-3xl text-3xl font-black leading-tight text-white drop-shadow-lg md:text-5xl">{item.title}</h1>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-primary" onClick={() => setVodSource(id, storeVodSeason ?? 1, storeVodEpisode ?? 1)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
              {resumePct !== null ? `Reprendre · E${storeVodEpisode ?? 1}` : 'Lecture'}
            </button>
            <FavoriteButton
              label={isFavorite ? `Retirer ${item.title} des favoris` : `Ajouter ${item.title} aux favoris`}
              isActive={isFavorite}
              onToggle={() => toggleFavorite(id)}
            />
            <Link href="/vod" className="btn bg-white/15 text-white backdrop-blur hover:bg-white/25">
              <Icon.ChevronLeft size={14} /> Catalogue
            </Link>
          </div>
          {resumePct !== null && (
            <div className="mt-3 max-w-xs">
              <div className="h-1 overflow-hidden rounded-full bg-white/20">
                <div className="h-full bg-accent" style={{ width: `${resumePct}%` }} />
              </div>
              <p className="mt-1 text-xs text-white/70">{resumePct} % vus · reprise à {formatTime(progress!.position)}</p>
            </div>
          )}
        </div>
      </section>

      <div className="mx-auto w-full max-w-6xl px-4">
        <div className="mt-6 flex flex-col gap-6 md:flex-row">
          <div className="w-36 shrink-0 md:w-48">
            <div className="aspect-[2/3] overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
              {item.posterUrl ? (
                <img src={item.posterUrl} alt={`Affiche de ${item.title}`} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-muted/40"><Icon.Film size={40} /></div>
              )}
            </div>
          </div>

          <div className="min-w-0 flex-1">
            {isSeries && (
              <div>
                {episodesQuery.isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
                {episodesQuery.isError && <p className="text-sm text-muted">Épisodes indisponibles pour le moment.</p>}
                {seasons.length > 0 && (
                  <>
                    <h2 className="mb-3 text-lg font-bold">Épisodes</h2>
                    {seasons.length > 1 && (
                      <div className="mb-4 flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        {seasons.map((season) => (
                          <button key={season.number} type="button" onClick={() => setSelectedSeason(season.number)}
                            className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition ${season.number === activeSeason ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:text-text'}`}>
                            Saison {season.number}
                          </button>
                        ))}
                      </div>
                    )}
                    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                      {seasonData?.episodes.map((episode) => {
                        const isCurrent = episode.num === startAt?.num;
                        return (
                          <li key={episode.id}>
                            <button type="button"
                              onClick={() => { setVodEpisode(activeSeason ?? 1, episode.num); setVodSource(id, activeSeason ?? 1, episode.num); }}
                              className={`group flex w-full items-center gap-4 px-4 py-3 text-left transition hover:bg-surface ${isCurrent ? 'bg-accent/5' : ''}`}>
                              <span className={`w-8 shrink-0 text-center text-sm font-bold tabular-nums ${isCurrent ? 'text-accent' : 'text-muted'}`}>{episode.num}</span>
                              <span className="min-w-0 flex-1">
                                <span className={`block truncate text-sm font-semibold ${isCurrent ? 'text-accent' : ''}`}>{episode.title ?? `Épisode ${episode.num}`}</span>
                                {isCurrent && <span className="block text-xs text-muted">Reprise de lecture</span>}
                              </span>
                              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border text-muted transition group-hover:border-accent group-hover:bg-accent group-hover:text-on-accent">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>
            )}
            {!isSeries && (
              <div className="rounded-xl border border-border bg-surface p-4 text-sm text-muted">
                Lecture directe depuis le fournisseur — pas de liste d'épisodes pour un film.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function VodDetailPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <VodDetailContent />
    </Suspense>
  );
}
