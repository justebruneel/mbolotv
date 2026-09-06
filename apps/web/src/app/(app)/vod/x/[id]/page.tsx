'use client';

// Fiche film externe (lecteurs tiers) façon Netflix : hero (backdrop, titre,
// année, trailer), sélecteur « Lecteur 1/2/3 » façon Wiflix, puis lecture :
// - direct : Player maison avec l'URL résolue au clic via /api/x/play ;
//   en cas d'échec de résolution, repli automatique sur l'iframe du lecteur
//   (le film joue toujours, notice dans la barre de lecture) ;
// - iframe : embed d'origine en plein cadre 16:9 (sans sandbox : les players
//   tiers redirigent /blocked quand ils détectent l'attribut sandbox).
// Lecteur inline propre (comme la fiche Nollywood) : GlobalPlayer exclut
// /vod/x/* de sa capture, et on libère le mini-lecteur VOD au montage.
import { EmptyState, Icon, Player, Spinner } from '@mbolo/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useExternalPlay, useExternalTitle } from '../../../../../shared/api/queries';
import { useSettingsStore } from '../../../../../shared/stores/settings';
import { useVodPlayerStore } from '../../../../../shared/stores/player';

function ExternalDetailContent() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const detailQuery = useExternalTitle(id, Boolean(id));
  const queryClient = useQueryClient();
  const clearVod = useVodPlayerStore((state) => state.clearVod);
  const volume = useSettingsStore((state) => state.volume);
  const setVolume = useSettingsStore((state) => state.setVolume);

  // La page a son propre lecteur : libérer le mini-lecteur VOD éventuel.
  useEffect(() => { clearVod(); }, [clearVod]);

  const sources = detailQuery.data?.sources ?? [];
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = sources[Math.min(selectedIndex, Math.max(0, sources.length - 1))] ?? null;
  // Ref de lecture demandée : évite d'afficher un flux résolu pour une
  // sélection précédente après changement de lecteur.
  const [requestedRef, setRequestedRef] = useState<string | null>(null);
  const [iframeStarted, setIframeStarted] = useState(false);

  const playQuery = useExternalPlay(selected?.host ?? 'mixdrop', selected?.playRef ?? '', false);

  // Progression (miroir de la fiche Nollywood) : persistance locale throttlée
  // 5 s pour « Reprendre » + position restaurée par le lecteur. Hooks
  // déclarés AVANT les early-returns (React #310) — item est calculé après,
  // on lit donc detailQuery.data.
  // Préfixe x: : espace d'ids propre, sans collision avec les ids VodItem
  // Xtream (ResumeRow route le préfixe vers /vod/x/<id>).
  const progressId = useMemo(() => `x:${id}`, [id]);
  const [startAt, setStartAt] = useState(0);
  const recordVodProgress = useSettingsStore((state) => state.recordVodProgress);
  const lastWriteRef = useMemo(() => ({ at: 0 }), []);
  const handleProgress = useMemo(() => {
    return (seconds: number, duration: number): void => {
      const now = Date.now();
      if (now - lastWriteRef.at < 5_000) return;
      lastWriteRef.at = now;
      recordVodProgress({
        id: progressId,
        kind: 'MOVIE',
        title: detailQuery.data?.title ?? 'Film',
        posterUrl: detailQuery.data?.posterUrl ?? null,
        category: 'Externe',
        position: seconds,
        duration,
        updatedAt: new Date().toISOString(),
      });
    };
  }, [detailQuery.data?.title, detailQuery.data?.posterUrl, progressId, recordVodProgress, lastWriteRef]);
  // Refresh d'URL pour le lecteur : les liens signés des extracteurs expirent
  // (expiresInSeconds) — sans ce branchement, exhausted() du Player se termine
  // sur l'écran d'erreur sans pouvoir re-résoudre le flux.
  const refreshPlayUrl = useCallback(async (): Promise<boolean> => {
    try {
      const result = await playQuery.refetch();
      return result.isSuccess;
    } catch {
      return false;
    }
  }, [playQuery]);

  const selectSource = useCallback((index: number): void => {
    setSelectedIndex(index);
    setRequestedRef(null);
    setIframeStarted(false);
  }, []);

  // Déclaré avant les early-returns (React #310 : nombre de hooks stable).
  const startPlayback = useCallback((): void => {
    if (!selected) return;
    if (selected.mode === 'iframe') {
      setIframeStarted(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    // Reprise : figée à l'INSTANT du clic (state) — lire vodProgress au render
    // n'est pas fiable avant l'hydratation du persist (même motif que Nollywood).
    const entry = useSettingsStore.getState().vodProgress[progressId];
    const pos = entry && entry.duration > 0 && entry.position > 30 && entry.position < entry.duration - 30 ? entry.position : 0;
    setStartAt(pos);
    setRequestedRef(selected.playRef);
    void playQuery.refetch();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [playQuery, selected, progressId]);

  const stopPlayback = useCallback((): void => {
    setRequestedRef(null);
    setIframeStarted(false);
    if (selected) queryClient.removeQueries({ queryKey: ['x-play', selected.host, selected.playRef] });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [queryClient, selected]);

  if (!id) return <EmptyState title="Contenu introuvable" />;
  if (detailQuery.isLoading) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (detailQuery.isError || !detailQuery.data) {
    return <EmptyState title="Contenu introuvable" hint="Ce titre n'est plus disponible dans le catalogue." />;
  }

  const item = detailQuery.data;
  const backdropUrl = item.backdropUrl ?? item.posterUrl;
  const directUrls = selected?.mode === 'direct' && requestedRef === selected.playRef ? playQuery.data?.urls ?? [] : [];
  // Repli intelligent : la résolution directe a échoué (extracteur périmé,
  // CDN indisponible…) — on monte l'embed du lecteur en iframe pour que le
  // film joue quand même, le Player Mbolo restant la voie préférée.
  const directFailed = selected?.mode === 'direct' && requestedRef !== null && playQuery.isError && directUrls.length === 0;
  const iframePlaying = (selected?.mode === 'iframe' && iframeStarted) || directFailed;
  const playing = directUrls.length > 0 || iframePlaying;

  return (
    <div className="pb-10">
      <section className={playing ? 'relative z-0 -mt-px aspect-video w-full bg-black' : 'relative z-0 -mt-px h-[240px] sm:h-[340px] md:h-[400px] lg:h-[480px]'}>
        {playing ? (
          <div className="absolute inset-0 bg-black" data-player-chrome>
            {directUrls.length > 0 && selected ? (
              <Player
                key={`${selected.host}:${selected.playRef}`}
                urls={directUrls}
                title={item.title}
                mode="vod"
                initialTime={startAt}
                onProgress={handleProgress}
                onRefreshSource={refreshPlayUrl}
                initialVolume={volume}
                onVolumeChange={setVolume}
                autoPlay
              />
            ) : (
              selected && (
                <iframe
                  key={selected.playRef}
                  src={selected.playRef}
                  title={`Lecteur ${selected.host} — ${item.title}`}
                  className="h-full w-full"
                  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                  allowFullScreen
                />
              )
            )}
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
            <div className="absolute inset-x-0 bottom-0 mx-auto hidden w-full max-w-6xl px-4 pb-6 md:block md:pb-8">
              <div className="flex flex-wrap items-center gap-2 text-xs text-white/80">
                <span className="rounded bg-white/15 px-2 py-0.5 font-bold uppercase tracking-wide backdrop-blur">Film</span>
                {item.year != null && <span>{item.year}</span>}
                <span>{sources.length} lecteur{sources.length > 1 ? 's' : ''}</span>
              </div>
              <h1 className="mt-2 max-w-3xl text-3xl font-black leading-tight text-white drop-shadow-lg md:text-5xl">{item.title}</h1>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {sources.length > 0 && (
                  playQuery.isFetching ? (
                    <button type="button" className="btn btn-primary" disabled>
                      <Spinner />
                      Résolution du flux…
                    </button>
                  ) : (
                    <button type="button" className="btn btn-primary" onClick={startPlayback}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                      Lecture
                    </button>
                  )
                )}
                {item.trailerYoutubeId && (
                  <Link href={`/vod/yt/${item.trailerYoutubeId}`} className="btn">
                    <Icon.Film size={14} /> Bande-annonce
                  </Link>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      {playing && (
        <div className="sticky top-[56px] z-30 mx-auto mt-4 flex w-full max-w-6xl flex-wrap items-center gap-3 bg-[var(--mbolo-bg)] px-4 py-2 shadow-sm">
          <button type="button" className="btn btn-primary btn-sm" onClick={stopPlayback}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z" /></svg>
            Arrêter
          </button>
          {directFailed && (
            <span className="text-xs text-muted">Lecteur Mbolo indisponible — lecteur source utilisé</span>
          )}
          <span className="min-w-0 flex-1 truncate text-right text-xs text-muted">{item.title}</span>
        </div>
      )}

      <div className="mx-auto w-full max-w-6xl px-4">
        <div className="mt-4 md:hidden">
          <p className="text-lg font-bold leading-snug">{item.title}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {item.year != null && <span>{item.year}</span>}
            <span>{sources.length} lecteur{sources.length > 1 ? 's' : ''}</span>
          </div>
          {!playing && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {sources.length > 0 && (
                playQuery.isFetching ? (
                  <button type="button" className="btn btn-primary" disabled>
                    <Spinner />
                    Résolution du flux…
                  </button>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={startPlayback}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                    Lecture
                  </button>
                )
              )}
              {item.trailerYoutubeId && (
                <Link href={`/vod/yt/${item.trailerYoutubeId}`} className="btn">
                  <Icon.Film size={14} /> Bande-annonce
                </Link>
              )}
            </div>
          )}
        </div>

        {/* Sélecteur façon Wiflix : un bouton par lecteur (host + mode +
            versions), le premier par défaut. Pendant la lecture, le
            changement de lecteur relance via Lecture/Arrêter. */}
        {sources.length > 0 && (
          <div className="mt-4 border-t border-border/60 pt-4 md:mt-8 md:pt-6">
            <h2 className="mb-3 text-base font-bold">Lecteurs ({sources.length})</h2>
            <div className="flex flex-wrap gap-2">
              {sources.map((source, index) => (
                <button
                  key={source.id}
                  type="button"
                  onClick={() => selectSource(index)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition ${index === Math.min(selectedIndex, sources.length - 1)
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border text-muted hover:text-text'}`}
                >
                  Lecteur {index + 1} · {source.host}
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${source.mode === 'direct' ? 'bg-accent/20 text-accent' : 'bg-surface-2 text-muted'}`}>
                    {source.mode === 'direct' ? 'direct' : 'iframe'}
                  </span>
                  {source.versions.length > 0 && <span className="text-xs font-normal opacity-60">{source.versions.join(', ')}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-col gap-4 md:flex-row md:gap-6">
          {!playing && item.posterUrl && (
            <div className="aspect-[2/3] w-32 shrink-0 overflow-hidden rounded-xl border border-border bg-surface shadow-lg sm:w-40">
              <img src={item.posterUrl} alt={`Affiche de ${item.title}`} className="h-full w-full object-cover" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-relaxed text-muted">Film ajouté via lecteurs tiers, sans publicité.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ExternalDetailPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <ExternalDetailContent />
    </Suspense>
  );
}
