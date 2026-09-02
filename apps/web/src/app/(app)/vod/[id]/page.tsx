'use client';

import { EmptyState, Icon, Spinner } from '@mbolo/ui';
import { useParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
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

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-10">
      {/* Slot du lecteur global : GlobalPlayer vient s'y caler (pattern /watch). */}
      <div id="vod-player-slot" className="aspect-video w-full overflow-hidden rounded-xl bg-black" />

      <div className="mt-5 flex flex-col gap-5 sm:flex-row">
        <div className="w-32 shrink-0 sm:w-44">
          <div className="aspect-[2/3] overflow-hidden rounded-lg border border-border bg-surface">
            {item.posterUrl ? (
              <img src={item.posterUrl} alt={`Affiche de ${item.title}`} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center text-muted/40"><Icon.Film size={40} /></div>
            )}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h1 className="text-2xl font-bold">{item.title}</h1>
            <FavoriteButton
              label={isFavorite ? `Retirer ${item.title} des favoris` : `Ajouter ${item.title} aux favoris`}
              isActive={isFavorite}
              onToggle={() => toggleFavorite(id)}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            {isSeries ? <span className="rounded-md bg-surface px-2 py-0.5 font-semibold">Série</span> : <span className="rounded-md bg-surface px-2 py-0.5 font-semibold">Film</span>}
            {item.category && <span>{item.category}</span>}
            {item.rating !== null && item.rating > 0 && (
              <span className="inline-flex items-center gap-1 font-semibold text-accent"><Icon.Star size={12} /> {item.rating.toFixed(1)}</span>
            )}
            {item.addedAt && <span>Ajouté le {new Date(item.addedAt).toLocaleDateString('fr-FR')}</span>}
          </div>

          {progress && progress.duration > 0 && progress.position > 30 && (
            <div className="mt-3 max-w-sm">
              <div className="h-1 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full bg-accent" style={{ width: `${Math.min(100, (progress.position / progress.duration) * 100)}%` }} />
              </div>
              <p className="mt-1 text-xs text-muted">Reprise à {formatTime(progress.position)} · {Math.round((progress.position / Math.max(1, progress.duration)) * 100)} % vus</p>
            </div>
          )}

          {isSeries && (
            <div className="mt-5">
              {episodesQuery.isLoading && <div className="flex justify-center py-6"><Spinner /></div>}
              {episodesQuery.isError && <p className="text-sm text-muted">Épisodes indisponibles pour le moment.</p>}
              {seasons.length > 0 && (
                <>
                  {seasons.length > 1 && (
                    <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                      {seasons.map((season) => (
                        <button key={season.number} type="button" onClick={() => setSelectedSeason(season.number)}
                          className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${season.number === activeSeason ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:text-text'}`}>
                          Saison {season.number}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="grid max-h-80 gap-1.5 overflow-y-auto pr-1">
                    {seasonData?.episodes.map((episode) => (
                      <button key={episode.id} type="button"
                        onClick={() => { setVodEpisode(activeSeason ?? 1, episode.num); setVodSource(id, activeSeason ?? 1, episode.num); }}
                        className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition ${episode.num === startAt?.num ? 'border-accent/60 bg-accent/5' : 'border-border hover:border-accent/40 hover:bg-surface'}`}>
                        <span className="min-w-0 flex-1 truncate">
                          <span className="mr-2 font-semibold text-muted">E{episode.num}</span>
                          {episode.title ?? `Épisode ${episode.num}`}
                        </span>
                        <Icon.Play size={14} className="shrink-0 text-muted" />
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
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
