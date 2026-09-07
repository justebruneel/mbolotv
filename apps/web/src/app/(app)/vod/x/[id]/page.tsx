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
import { EmptyState, FavoriteButton, Icon, Player, Spinner } from '@mbolo/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useExternalPlay, useExternalTitle, useYoutubePlay } from '../../../../../shared/api/queries';
import { useSettingsStore } from '../../../../../shared/stores/settings';
import { useVodPlayerStore } from '../../../../../shared/stores/player';
import { externalFavoriteId, useExternalFavoritesStore } from '../../../../../shared/stores/externalFavorites';
import { NativeTrailerFrame, TrailerFrame, useTrailerEmbed } from '../../../../../features/vod/components/TrailerHero';
import type { ExternalSourcePublic } from '@mbolo/contracts';

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
  // Lecteurs déjà essayés sans succès (résolution ou lecture) : l'enchaînement
  // auto passe au suivant, sans boucler. Remis à zéro à l'Arrêter.
  const [failedRefs, setFailedRefs] = useState<ReadonlySet<string>>(() => new Set());
  // Notice d'enchaînement : « Lecteur 2 — videozz » a été tenté sans succès.
  const [skippedHost, setSkippedHost] = useState<string | null>(null);

  const playQuery = useExternalPlay(selected?.host ?? 'mixdrop', selected?.playRef ?? '', false);

  // Progression (miroir de la fiche Nollywood) : persistance locale throttlée
  // 5 s pour « Reprendre » + position restaurée par le lecteur. Hooks
  // déclarés AVANT les early-returns (React #310) — item est calculé après,
  // on lit donc detailQuery.data.
  // Préfixe x: : espace d'ids propre, sans collision avec les ids VodItem
  // Xtream (ResumeRow route le préfixe vers /vod/x/<id>).
  const progressId = useMemo(() => `x:${id}`, [id]);
  // Favori titre externe : store local pur (jamais servi — même motif que
  // Nollywood), clé préfixée « x: ».
  const isFavorite = useExternalFavoritesStore((state) => state.ids.includes(externalFavoriteId(id)));
  const toggleFavorite = useExternalFavoritesStore((state) => state.toggle);
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

  // Sélection pilotée par INDEX de la liste triée (VF prioritaire côté API) :
  // le clic Lecture part sur la source d'ordre 0 et descend la liste au besoin.
  const selectedIndexRef = useRef(0);
  selectedIndexRef.current = Math.min(selectedIndex, Math.max(0, sources.length - 1));
  const failedRefsRef = useRef<ReadonlySet<string>>(new Set());
  failedRefsRef.current = failedRefs;
  // Position au moment de la bascule de lecteur : un changement de source
  // remonte un nouveau Player (key host:playRef) — la reprise inter-lecteurs
  // passe par la progression persistée, à jour à ~5 s (throttle recordVodProgress).
  const positionAtSwitchRef = useRef(0);
  const [autoSwitching, setAutoSwitching] = useState(false);

  // Démarre la lecture de `source` : direct = résolution au clic (avec reprise
  // de position), iframe = embed plein cadre (dernier recours uniquement).
  const launchSource = useCallback((source: ExternalSourcePublic, position: number): void => {
    setStartAt(position);
    setRequestedRef(source.playRef);
    if (source.mode === 'iframe') setIframeStarted(true);
    else void playQuery.refetch();
  }, [playQuery]);

  // Déclaré avant les early-returns (React #310 : nombre de hooks stable).
  const startPlayback = useCallback((): void => {
    // Le clic Lecture part sur la source d'ordre 0 : l'API trie déjà direct
    // d'abord puis VF > VOSTFR > default — c'est le « meilleur lecteur ».
    const source = sources[0];
    if (!source) return;
    if (source.mode === 'iframe') {
      // Un seul lecteur, en iframe : l'utilisateur n'a pas d'alternative.
      setFailedRefs(new Set());
      setSkippedHost(null);
      launchSource(source, 0);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    // Reprise : figée à l'INSTANT du clic (state) — lire vodProgress au render
    // n'est pas fiable avant l'hydratation du persist (même motif que Nollywood).
    const entry = useSettingsStore.getState().vodProgress[progressId];
    const pos = entry && entry.duration > 0 && entry.position > 30 && entry.position < entry.duration - 30 ? entry.position : 0;
    setFailedRefs(new Set());
    setSkippedHost(null);
    setAutoSwitching(false);
    launchSource(source, pos);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [sources, progressId, launchSource]);

  // Changement de lecteur DEPUIS LE PLAYER (icône serveur) : même position
  // (relue du store, à ~5 s), sans passer par Lecture/Arrêter. Les sources
  // essayées repartent à zéro : c'est un choix explicite de l'utilisateur.
  const handleSourceChange = useCallback((sourceId: string): void => {
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source) return;
    setSelectedIndex(sources.indexOf(source));
    setFailedRefs(new Set());
    setSkippedHost(null);
    setAutoSwitching(false);
    setIframeStarted(false);
    // Purge la résolution du lecteur précédent (playRef obsolète, jetons
    // à usage unique) pour éviter qu'un cache périmé serve au nouveau.
    for (const played of sources) {
      if (played.id !== sourceId) queryClient.removeQueries({ queryKey: ['x-play', played.host, played.playRef] });
    }
    const position = useSettingsStore.getState().vodProgress[progressId]?.position ?? 0;
    launchSource(source, position);
  }, [sources, progressId, launchSource, queryClient]);

  const stopPlayback = useCallback((): void => {
    setRequestedRef(null);
    setIframeStarted(false);
    setFailedRefs(new Set());
    setSkippedHost(null);
    setAutoSwitching(false);
    if (selected) queryClient.removeQueries({ queryKey: ['x-play', selected.host, selected.playRef] });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [queryClient, selected]);

  // Valeurs dérivées calculées AVANT les early-returns : playing et trailer
  // dépendent de requêtes, pas de `item` — et tout hook doit être appelé sur
  // CHAQUE render (React #310 : l'appeler après un return conditionnel fait
  // varier le nombre de hooks entre le render « chargement » et le render
  // « fiche », exactement le crash minifié #310).
  const directUrls = selected?.mode === 'direct' && requestedRef === selected.playRef ? playQuery.data?.urls ?? [] : [];
  // Repli intelligent : la résolution directe a échoué (extracteur périmé,
  // CDN indisponible…) — on monte l'embed du lecteur en iframe pour que le
  // film joue quand même, le Player Mbolo restant la voie préférée.
  const directFailed = selected?.mode === 'direct' && requestedRef !== null && playQuery.isError && directUrls.length === 0;
  const iframePlaying = (selected?.mode === 'iframe' && iframeStarted) || directFailed;
  const playing = directUrls.length > 0 || iframePlaying;
  // Bande-annonce façon Netflix. Voie PRÉFÉRÉE : lecture native — le MP4
  // résolu par la pipeline Nollywood (/api/yt/play → InnerTube → proxy signé)
  // dans un <video loop> HTML5 : boucle réelle sans rechargement, octets du
  // 2ᵉ passage servis par le cache edge, AUCUNE interface YouTube possible,
  // mute/unmute natif. L'iframe youtube-nocookie (useTrailerEmbed) n'est que
  // le REPLI si la résolution native échoue (vidéo restreinte, refus InnerTube) ;
  // l'image de fond et le lien fiche Nollywood restent les derniers recours.
  // Coupée dès que le film joue (videoId vide = rien de monté).
  const trailerVideoId = playing ? '' : (detailQuery.data?.trailerYoutubeId ?? '');
  const trailerPlayQuery = useYoutubePlay(trailerVideoId, Boolean(trailerVideoId));
  const [nativeTrailerFailed, setNativeTrailerFailed] = useState(false);
  const [nativeTrailerReady, setNativeTrailerReady] = useState(false);
  const [trailerSound, setTrailerSound] = useState(false);
  const trailerVideoRef = useRef<HTMLVideoElement | null>(null);
  const nativeTrailerUrls = trailerPlayQuery.data?.urls ?? [];
  const showNativeTrailer = Boolean(trailerVideoId) && !nativeTrailerFailed && nativeTrailerUrls.length > 0;
  const trailerIframeId = trailerVideoId && !showNativeTrailer && (nativeTrailerFailed || trailerPlayQuery.isError) ? trailerVideoId : '';
  const trailer = useTrailerEmbed(trailerIframeId);
  const trailerActive = showNativeTrailer || (trailer.mounted && !trailer.failed);
  const trailerMuted = showNativeTrailer ? !trailerSound : trailer.muted;
  const trailerVisible = showNativeTrailer ? nativeTrailerReady : (trailer.mounted && trailer.ready && !trailer.failed);
  const unmuteTrailer = useCallback((): void => {
    const video = trailerVideoRef.current;
    if (video) { video.muted = false; video.volume = 1; setTrailerSound(true); return; }
    trailer.unmute();
  }, [trailer]);
  const muteTrailer = useCallback((): void => {
    const video = trailerVideoRef.current;
    if (video) { video.muted = true; setTrailerSound(false); return; }
    trailer.mute();
  }, [trailer]);

  // Enchaînement automatique : la résolution du lecteur courant a échoué
  // (extracteur périmé, CDN indisponible…) → on tente le lecteur DIRECT
  // suivant de la liste (VF prioritaire), l'iframe n'étant que le dernier
  // recours. La progression persistée (à ~5 s) restaure la position chez le
  // lecteur suivant. Boucle impossible : chaque source essayée entre dans
  // failedRefs ; l'effet ne retente que du neuf.
  useEffect(() => {
    if (!requestedRef || !selected || selected.mode !== 'direct') return;
    if (!playQuery.isError || playQuery.isFetching || autoSwitching) return;
    const ref = selected.playRef;
    if (failedRefsRef.current.has(ref)) return;
    const nextFailed = new Set<string>(failedRefsRef.current);
    nextFailed.add(ref);
    // Premier lecteur direct non encore essayé APRÈS celui qui vient d'échouer.
    const fallback = sources
      .slice(selectedIndexRef.current + 1)
      .find((candidate) => candidate.mode === 'direct' && !nextFailed.has(candidate.playRef)) ?? null;
    setFailedRefs(nextFailed);
    setSkippedHost(selected.host);
    if (!fallback) {
      // Aucun direct restant : repli iframe du lecteur courant (comportement
      // historique) pour que le film joue quand même.
      setIframeStarted(true);
      setRequestedRef(null);
      return;
    }
    setAutoSwitching(true);
    setSelectedIndex(sources.indexOf(fallback));
    positionAtSwitchRef.current = useSettingsStore.getState().vodProgress[progressId]?.position ?? 0;
    launchSource(fallback, positionAtSwitchRef.current);
  }, [requestedRef, selected, playQuery.isError, playQuery.isFetching, autoSwitching, sources, progressId, launchSource]);

  if (!id) return <EmptyState title="Contenu introuvable" />;
  if (detailQuery.isLoading) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (detailQuery.isError || !detailQuery.data) {
    return <EmptyState title="Contenu introuvable" hint="Ce titre n'est plus disponible dans le catalogue." />;
  }

  const item = detailQuery.data;
  const backdropUrl = item.backdropUrl ?? item.posterUrl;

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
                sources={sources.map(({ id, host, versions, mode }) => ({ id, host, versions, mode }))}
                activeSourceId={selected.id}
                onSourceChange={handleSourceChange}
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
            {/* Image de fond : affichée tant que la bande-annonce ne joue pas
                RÉELLEMENT (native : premier « playing » du <video> ; iframe :
                événement onStateChange du player), puis fondu croisé 700 ms. */}
            <img
              key={backdropUrl ?? 'no-backdrop'}
              src={backdropUrl ?? ''}
              alt=""
              className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-700 ${trailerVisible ? 'opacity-0' : 'opacity-85'}`}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = backdropUrl ? 'visible' : 'hidden'; }}
            />
            {!backdropUrl && <div className="absolute inset-0 bg-gradient-to-br from-surface-2 to-surface" />}
            {/* Bande-annonce native (MP4 du proxy, loop HTML5) : aucune
                interface YouTube par construction ; object-cover remplit le
                hero sans dézoom ni cadre. Clic = activer le son. */}
            {showNativeTrailer && (
              <div className="absolute inset-0 overflow-hidden" onClick={unmuteTrailer} role="presentation">
                <NativeTrailerFrame
                  urls={nativeTrailerUrls}
                  videoRef={trailerVideoRef}
                  onReady={() => setNativeTrailerReady(true)}
                  onFailed={() => setNativeTrailerFailed(true)}
                  className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${nativeTrailerReady ? 'opacity-100' : 'opacity-0'}`}
                />
                {trailerSound && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); muteTrailer(); }}
                    aria-label="Couper le son de la bande-annonce"
                    className="absolute right-3 top-3 z-20 rounded-full bg-black/70 p-1.5 text-white backdrop-blur"
                  >
                    <Icon.Volume2 size={13} aria-hidden />
                  </button>
                )}
              </div>
            )}
            {/* Repli iframe YouTube (vidéo native non résolue) : invisible
                (opacity 0) tant que la vidéo ne joue pas, puis fondu. L'iframe
                est dézoomée (scale 1,25) et recentrée pour couper le chrome
                YouTube hors cadre. */}
            {!showNativeTrailer && trailer.mounted && !trailer.failed && trailer.src && (
              <div className="absolute inset-0 overflow-hidden" onClick={unmuteTrailer} role="presentation">
                <TrailerFrame
                  src={trailer.src}
                  onFailed={trailer.setFailed}
                  frameRef={trailer.frameRef}
                  className={`pointer-events-none absolute left-1/2 top-1/2 aspect-video w-full -translate-x-1/2 -translate-y-1/2 scale-125 transition-opacity duration-700 ${trailer.ready ? 'opacity-100' : 'opacity-0'}`}
                />
                {!trailer.muted && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); muteTrailer(); }}
                    aria-label="Couper le son de la bande-annonce"
                    className="absolute right-3 top-3 z-20 rounded-full bg-black/70 p-1.5 text-white backdrop-blur"
                  >
                    <Icon.Volume2 size={13} aria-hidden />
                  </button>
                )}
              </div>
            )}
            {/* Dégradé vertical léger au bas uniquement (fondu vers la page) ;
                le voile latéral sombre est supprimé : c'est lui qui coupait le
                hero en deux (côté sombre derrière le titre). La lisibilité du
                texte est assurée par drop-shadow/OMBRE sur chaque élément. */}
            <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-[#0b0b0f] via-[#0b0b0f]/40 to-transparent" />
            <div className="absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-black/35 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 mx-auto hidden w-full max-w-6xl px-4 pb-6 md:block md:pb-8">
              <div className="flex flex-wrap items-center gap-2 text-xs text-white/80">
                <span className="rounded bg-white/15 px-2 py-0.5 font-bold uppercase tracking-wide backdrop-blur">Film</span>
                {item.year != null && <span>{item.year}</span>}
                <span>{sources.length} lecteur{sources.length > 1 ? 's' : ''}</span>
              </div>
              <h1 className="mt-2 max-w-3xl text-3xl font-black leading-tight text-white [text-shadow:0_2px_10px_rgba(0,0,0,0.9),0_0_24px_rgba(0,0,0,0.65)] md:text-5xl">{item.title}</h1>
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
                  trailerActive ? (
                    <button type="button" className="btn" onClick={trailerMuted ? unmuteTrailer : muteTrailer}>
                      {trailerMuted ? <><Icon.VolumeX size={14} /> Activer le son</> : <><Icon.Volume2 size={14} /> Couper le son</>}
                    </button>
                  ) : (
                    <Link href={`/vod/yt/${item.trailerYoutubeId}`} className="btn">
                      <Icon.Film size={14} /> Bande-annonce
                    </Link>
                  )
                )}
                <FavoriteButton
                  isActive={isFavorite}
                  onToggle={() => toggleFavorite(externalFavoriteId(id))}
                  label={isFavorite ? `Retirer ${item.title} des favoris` : `Ajouter ${item.title} aux favoris`}
                />
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
          {skippedHost && (
            <span className="text-xs text-muted">
              Lecteur {skippedHost} indisponible{directFailed ? ' — lecteur source utilisé' : ' — lecteur suivant essayé'}
            </span>
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
                trailerActive ? (
                  <button type="button" className="btn" onClick={trailerMuted ? unmuteTrailer : muteTrailer}>
                    {trailerMuted ? <><Icon.VolumeX size={14} /> Activer le son</> : <><Icon.Volume2 size={14} /> Couper le son</>}
                  </button>
                ) : (
                  <Link href={`/vod/yt/${item.trailerYoutubeId}`} className="btn">
                    <Icon.Film size={14} /> Bande-annonce
                  </Link>
                )
              )}
              <FavoriteButton
                isActive={isFavorite}
                onToggle={() => toggleFavorite(externalFavoriteId(id))}
                label={isFavorite ? `Retirer ${item.title} des favoris` : `Ajouter ${item.title} aux favoris`}
              />
            </div>
          )}
        </div>

        {/* Sélecteur façon Wiflix supprimé : la liste des lecteurs vit
            désormais DANS le Player Mbolo (icône serveur, rails + popup
            mobile). Ici, la fiche ne fait qu'afficher le nombre. */}

        <div className="mt-4 flex flex-col gap-4 md:flex-row md:gap-6">
          {!playing && item.posterUrl && (
            <div className="aspect-[2/3] w-32 shrink-0 overflow-hidden rounded-xl border border-border bg-surface shadow-lg sm:w-40 md:w-44">
              <img src={item.posterUrl} alt={`Affiche de ${item.title}`} className="h-full w-full object-cover" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            {item.synopsis || (item.genres?.length ?? 0) > 0 || item.duration || item.director || item.cast || item.originalTitle ? (
              <>
                {/* Rangée méta façon Netflix : genres en chips + durée —
                    une seule ligne, cachée si aucune de ces données. */}
                {(item.genres?.length ?? 0) > 0 || item.duration ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {(item.genres ?? []).map((genre) => (
                      <span key={genre} className="rounded border border-border bg-surface px-2 py-0.5 text-muted">{genre}</span>
                    ))}
                    {item.duration && <span className="text-muted">{item.duration}</span>}
                  </div>
                ) : null}
                {item.synopsis && (
                  <p className="mt-3 text-sm leading-relaxed md:text-[15px]">{item.synopsis}</p>
                )}
                {/* Rangée production (réalisateur/acteurs/titre original) :
                    libellés atténués, valeurs normales, façon fiche Netflix. */}
                {(item.director || item.cast || item.originalTitle) && (
                  <dl className="mt-4 space-y-1.5 text-xs md:text-sm">
                    {item.director && (
                      <div className="flex gap-2">
                        <dt className="shrink-0 text-muted">Réalisateur :</dt>
                        <dd>{item.director}</dd>
                      </div>
                    )}
                    {item.cast && (
                      <div className="flex gap-2">
                        <dt className="shrink-0 text-muted">Acteurs :</dt>
                        <dd>{item.cast}</dd>
                      </div>
                    )}
                    {item.originalTitle && (
                      <div className="flex gap-2">
                        <dt className="shrink-0 text-muted">Titre original :</dt>
                        <dd className="italic">{item.originalTitle}</dd>
                      </div>
                    )}
                  </dl>
                )}
              </>
            ) : (
              <p className="text-sm leading-relaxed text-muted">Film ajouté via lecteurs tiers, sans publicité.</p>
            )}
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
