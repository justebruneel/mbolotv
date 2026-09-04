'use client';

// Fiche film Nollywood « Netflix » : hero plein cadre (backdrop, titre,
// bouton Lecture), puis lecture dans NOTRE Player (@mbolo/ui) avec l'URL de
// flux résolue via /api/yt/play (InnerTube) — plus d'iframe YouTube.
// Fiche à trois niveaux (l'API détail peut être injoignable) : 1) API,
// 2) cache React Query des pages, 3) métadonnées embarquées dans l'URL.
import { EmptyState, Icon, Player, Spinner } from '@mbolo/ui';
import type { YoutubeVideo } from '@mbolo/contracts';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { YoutubeListResponse } from '@mbolo/contracts';
import { useYoutubePlay, useYoutubeVideo } from '../../../../../shared/api/queries';
import { useSettingsStore } from '../../../../../shared/stores/settings';
import { useVodPlayerStore } from '../../../../../shared/stores/player';
import { useYoutubeFavoritesStore, youtubeProgressId } from '../../../../../shared/stores/youtubeFavorites';
import { FavoriteButton } from '@mbolo/ui';

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function YoutubeDetailContent() {
  const params = useParams<{ videoId: string }>();
  const searchParams = useSearchParams();
  const videoId = typeof params.videoId === 'string' ? params.videoId : '';
  const itemQuery = useYoutubeVideo(videoId, Boolean(videoId));
  // Le flux ne se résout qu'au clic Lecture (enabled=false + refetch manuel) :
  // ni requête réseau inutile au chargement de la fiche, ni autoplay forcé.
  const playQuery = useYoutubePlay(videoId, false);
  const queryClient = useQueryClient();

  const item: YoutubeVideo | null = useMemo(() => {
    if (itemQuery.data) return itemQuery.data;
    const cached = queryClient
      .getQueriesData<InfiniteData<YoutubeListResponse>>({ queryKey: ['vod-youtube'] })
      .flatMap(([, data]) => data?.pages ?? [])
      .flatMap((page) => page?.items ?? [])
      .find((entry) => entry?.id === videoId);
    if (cached) return cached;
    const title = searchParams.get('t');
    if (!title) return null;
    return {
      id: videoId,
      title,
      description: null,
      posterUrl: searchParams.get('p'),
      publishedAt: searchParams.get('pub'),
      duration: null,
    };
  }, [itemQuery.data, queryClient, videoId, searchParams]);

  const progressId = useMemo(() => youtubeProgressId(videoId), [videoId]);
  const isFavorite = useYoutubeFavoritesStore((state) => state.ids.includes(progressId));
  const toggleFavorite = useYoutubeFavoritesStore((state) => state.toggle);
  const progress = useSettingsStore((state) => state.vodProgress[progressId]);
  const recordVodProgress = useSettingsStore((state) => state.recordVodProgress);
  const volume = useSettingsStore((state) => state.volume);
  const setVolume = useSettingsStore((state) => state.setVolume);
  const clearVod = useVodPlayerStore((state) => state.clearVod);

  // La page a son propre lecteur : libérer le mini-lecteur VOD éventuel pour
  // ne pas superposer deux lectures (GlobalPlayer ne connaît pas les ids yt:).
  useEffect(() => { clearVod(); }, [clearVod]);

  // Progression : même persistance que le VOD Xtream (throttle 5 s) pour
  // « Reprendre », la barre % et la tuile « continuer à regarder ».
  const lastWriteRef = useMemo(() => ({ at: 0 }), []);
  const handleProgress = useMemo(() => {
    return (seconds: number, duration: number): void => {
      const now = Date.now();
      if (now - lastWriteRef.at < 5_000) return;
      lastWriteRef.at = now;
      recordVodProgress({
        id: progressId,
        kind: 'MOVIE',
        title: item?.title ?? 'Vidéo',
        posterUrl: item?.posterUrl ?? null,
        category: 'Nollywood',
        position: seconds,
        duration,
        updatedAt: new Date().toISOString(),
      });
    };
  }, [item?.title, item?.posterUrl, progressId, recordVodProgress, lastWriteRef]);

  if (!videoId) return <EmptyState title="Contenu introuvable" />;
  if (itemQuery.isLoading && !item) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (!item) return <EmptyState title="Contenu introuvable" hint="Cette vidéo n'est plus disponible." />;

  // Backdrop héro via le proxy miniatures (q=maxres, repli hq automatique
  // côté route si la HD n'existe pas pour la vidéo).
  const backdropUrl = videoId ? `/api/yt/img?id=${videoId}&q=maxres` : null;
  const resumePct = progress && progress.duration > 0 && progress.position > 30
    ? Math.min(100, Math.round((progress.position / progress.duration) * 100))
    : null;
  const playUrls = playQuery.data?.urls ?? [];
  const playing = playUrls.length > 0;

  // Reprise : figée à l'INSTANT du clic Lecture (state, pas render-derived).
  // Lire vodProgress au render est non fiable : le store persist s'hydrate
  // après le premier render -> startAt aurait pu valoir 0 (reprise perdue).
  const [startAt, setStartAt] = useState(0);
  const refetchPlay = playQuery.refetch;
  const startPlayback = useCallback((): void => {
    const entry = useSettingsStore.getState().vodProgress[progressId];
    const pos = entry && entry.duration > 0 && entry.position > 30 && entry.position < entry.duration - 30 ? entry.position : 0;
    setStartAt(pos);
    void refetchPlay();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [refetchPlay, progressId]);

  // Arrêt : démonte le Player et purge la requête de flux (bouton ⏹ du hero).
  const stopPlayback = useCallback((): void => {
    queryClient.removeQueries({ queryKey: ['vod-youtube-play', videoId] });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [queryClient, videoId]);

  return (
    <div className="pb-10">
      {/* Hero Netflix : backdrop + actions. Dès que la lecture démarre, le
          Player prend SA place SEUL dans un cadre 16:9 natif (pas de hack de
          taille : forcer h-full sur les enfants du lecteur étire la .seekBar
          et son dégradé sombre sur toute l'image => rendu sombre). */}
      <section className={playing ? 'relative z-0 -mt-px aspect-video w-full bg-black' : 'relative z-0 -mt-px h-[340px] sm:h-[400px] md:h-[480px]'}>
        {playing ? (
          <div className="absolute inset-0 bg-black" data-player-chrome>
            <Player
              key={videoId}
              urls={playUrls}
              title={item.title}
              mode="vod"
              initialTime={startAt}
              onProgress={handleProgress}
              initialVolume={volume}
              onVolumeChange={setVolume}
              autoPlay
            />
          </div>
        ) : (
          <>
            {backdropUrl ? (
              <img src={backdropUrl} alt="" className="absolute inset-0 h-full w-full object-cover object-top opacity-85" />
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-surface-2 to-surface" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-[#0b0b0f] via-black/50 to-black/10" />
            <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/20 to-transparent" />

            <div className="absolute inset-x-0 bottom-0 mx-auto w-full max-w-6xl px-4 pb-6 md:pb-8">
              <div className="flex flex-wrap items-center gap-2 text-xs text-white/80">
                <span className="rounded bg-white/15 px-2 py-0.5 font-bold uppercase tracking-wide backdrop-blur">Film</span>
                <span>Nollywood · Aforevo</span>
                {item.duration !== null && item.duration > 0 && <span>{formatTime(item.duration)}</span>}
                {item.publishedAt && <span className="hidden sm:inline">{new Date(item.publishedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}</span>}
              </div>
              <h1 className="mt-2 max-w-3xl text-3xl font-black leading-tight text-white drop-shadow-lg md:text-5xl">{item.title}</h1>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {playQuery.isFetching ? (
                  <button type="button" className="btn btn-primary" disabled>
                    <Spinner />
                    Résolution du flux…
                  </button>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={startPlayback}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                    {resumePct !== null ? 'Reprendre' : 'Lecture'}
                  </button>
                )}
                <FavoriteButton
                  label={isFavorite ? `Retirer ${item.title} des favoris` : `Ajouter ${item.title} aux favoris`}
                  isActive={isFavorite}
                  onToggle={() => toggleFavorite(progressId)}
                />
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
          </>
        )}
      </section>

      {/* Barre de page pendant la lecture : Arrêter + Favori, SOUS le lecteur
          (le Player garde ses propres contrôles intacts). z-10 au-dessus du
          lecteur (z-0) : aucun chevauchement flottant possible, et marges
          généreuses pour empiler proprement la section détail dessous. */}
      {playing && (
        <div className="relative z-10 mx-auto mt-4 flex w-full max-w-6xl flex-wrap items-center gap-3 px-4">
          <button type="button" className="btn btn-primary" onClick={stopPlayback}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z" /></svg>
            Arrêter
          </button>
          <FavoriteButton
            label={isFavorite ? `Retirer ${item.title} des favoris` : `Ajouter ${item.title} aux favoris`}
            isActive={isFavorite}
            onToggle={() => toggleFavorite(progressId)}
          />
          <span className="text-xs text-muted">Nollywood · Aforevo{item.duration !== null && item.duration > 0 ? ` · ${formatTime(item.duration)}` : ''}</span>
        </div>
      )}

      {playQuery.isError && !playing && (
        <div className="mx-auto mt-8 w-full max-w-6xl px-4">
          <EmptyState title="Lecture indisponible" hint={playQuery.error instanceof Error ? playQuery.error.message : 'Flux introuvable pour cette vidéo.'} />
        </div>
      )}

      {/* Détail : affiche + synopsis, même langage que la fiche VOD Xtream.
         relative z-0 : reste sous la barre d'actions (z-10), empilement net. */}
      <div className="relative z-0 mx-auto w-full max-w-6xl px-4">
        <div className="mt-8 flex flex-col gap-6 border-t border-border/60 pt-6 md:flex-row">
          <div className="w-36 shrink-0 md:w-48">
            <div className="aspect-video overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
              {item.posterUrl ? (
                <img src={item.posterUrl} alt={`Affiche de ${item.title}`} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-muted/40"><Icon.Film size={40} /></div>
              )}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <p className="whitespace-pre-line text-sm leading-relaxed text-muted">
              {item.description ? `${item.description.slice(0, 800)}${item.description.length > 800 ? '…' : ''}` : 'Synopsis non disponible pour ce film.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function YoutubeDetailPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <YoutubeDetailContent />
    </Suspense>
  );
}
