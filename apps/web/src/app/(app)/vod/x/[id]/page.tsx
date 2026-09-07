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
import { ExternalEpisodeList } from '../../../../../features/vod/components/ExternalEpisodeList';
import type { ExternalSourcePublic } from '@mbolo/contracts';

// Références vides partagées : évitent de recréer un tableau neuf à chaque
// render (nouvelle identité = effet/callback dépendants qui re-tournent en
// boucle + re-renders zustand via Object.is). Cause suspecte du React #185.
const EMPTY_SOURCES: ExternalSourcePublic[] = [];
const EMPTY_EPISODES: Array<{ number: number; sources: ExternalSourcePublic[] }> = [];
const EMPTY_NUMBERS: number[] = [];
const EMPTY_STRINGS: string[] = [];

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

  const sources = detailQuery.data?.sources ?? EMPTY_SOURCES;
  // Séries : les sources portent le numéro d'épisode (bot). Sélection par
  // épisode façon Netflix : on choisit l'épisode, puis la meilleure source
  // (tri serveur : direct avant iframe, VF d'abord) de CET épisode.
  const isSeries = detailQuery.data?.kind === 'SERIES';
  const episodes = useMemo(() => {
    if (!isSeries) return EMPTY_EPISODES;
    const byNumber = new Map<number, typeof sources>();
    for (const source of sources) {
      const key = source.episode ?? 0;
      const list = byNumber.get(key) ?? [];
      list.push(source);
      byNumber.set(key, list);
    }
    return [...byNumber.entries()]
      .filter(([number]) => number > 0)
      .sort((a, b) => a[0] - b[0])
      .map(([number, episodeSources]) => ({ number, sources: episodeSources }));
  }, [isSeries, sources]);
  // Épisode affiché (null = film, ou série sans numéros exploitables).
  const [episodeNumber, setEpisodeNumber] = useState<number | null>(null);
  const activeEpisode = isSeries && episodes.length > 0
    ? (episodeNumber && episodes.some((entry) => entry.number === episodeNumber) ? episodeNumber : episodes[0].number)
    : null;
  // Sources du contexte actif : épisode choisi (série) ou toutes (film).
  // Mémoïsé : une identité neuve à chaque render ferait re-tourner l'effet
  // d'enchaînement et changerait les callbacks passés à la liste/Player.
  const activeSources = useMemo(() => (
    activeEpisode !== null
      ? (episodes.find((entry) => entry.number === activeEpisode)?.sources ?? sources)
      : sources
  ), [activeEpisode, episodes, sources]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = activeSources[Math.min(selectedIndex, Math.max(0, activeSources.length - 1))] ?? null;
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

  // Progression par épisode (façon Netflix) : persistance locale throttlée
  // 5 s pour « Reprendre » + position restaurée par le lecteur. Hooks
  // déclarés AVANT les early-returns (React #310) — item est calculé après,
  // on lit donc detailQuery.data.
  // Préfixe x: : espace d'ids propre, sans collision avec les ids VodItem
  // Xtream (ResumeRow route le préfixe vers /vod/x/<id>). L'entrée reste
  // unique par série (routage intact) et porte l'épisode courant.
  const progressId = useMemo(() => `x:${id}`, [id]);
  // Distribution repliée sur mobile (Netflix replie aussi le casting) :
  // ouverte par défaut sur desktop — les breakpoints gèrent l'affichage.
  const [castOpen, setCastOpen] = useState(false);
  // Favori titre externe : store local pur (jamais servi — même motif que
  // Nollywood), clé préfixée « x: ».
  const isFavorite = useExternalFavoritesStore((state) => state.ids.includes(externalFavoriteId(id)));
  const toggleFavorite = useExternalFavoritesStore((state) => state.toggle);
  const [startAt, setStartAt] = useState(0);
  const recordVodProgress = useSettingsStore((state) => state.recordVodProgress);
  const markVodEpisodeWatched = useSettingsStore((state) => state.markVodEpisodeWatched);
  const savedProgress = useSettingsStore((state) => state.vodProgress[progressId]);
  // Sélecteur stable (undefined quand absent) + fallback local partagé : le
  // `?? []` DANS le sélecteur allouait un tableau neuf à chaque évaluation.
  const watchedOrUndef = useSettingsStore((state) => state.vodWatchedEpisodes[progressId]);
  const watchedEpisodes = watchedOrUndef ?? EMPTY_NUMBERS;
  // Épisode courant vu par les callbacks (ref synchrone, pas de clôture périmée).
  const activeEpisodeRef = useRef<number | null>(null);
  activeEpisodeRef.current = activeEpisode;
  const isSeriesRef = useRef(false);
  isSeriesRef.current = isSeries;
  const lastWriteRef = useMemo(() => ({ at: 0 }), []);
  const handleProgress = useMemo(() => {
    return (seconds: number, duration: number): void => {
      const now = Date.now();
      if (now - lastWriteRef.at < 5_000) return;
      lastWriteRef.at = now;
      const episode = activeEpisodeRef.current;
      const series = isSeriesRef.current;
      const baseTitle = detailQuery.data?.title ?? 'Film';
      recordVodProgress({
        id: progressId,
        kind: series ? 'SERIES' : 'MOVIE',
        title: series && episode !== null ? `${baseTitle} · E${episode}` : baseTitle,
        posterUrl: detailQuery.data?.posterUrl ?? null,
        category: 'Externe',
        position: seconds,
        duration,
        updatedAt: new Date().toISOString(),
        episode: series ? episode : null,
      });
    };
  }, [detailQuery.data?.title, detailQuery.data?.posterUrl, progressId, recordVodProgress, lastWriteRef]);
  // Position de reprise pour un épisode : l'entrée ne s'applique que si elle
  // vise cet épisode (ou si elle est legacy sans épisode).
  const resumePositionFor = useCallback((episode: number | null): number => {
    const entry = useSettingsStore.getState().vodProgress[progressId];
    if (!entry || entry.duration <= 0) return 0;
    if (entry.episode !== null && entry.episode !== undefined && episode !== null && entry.episode !== episode) return 0;
    if (entry.position <= 30 || entry.position >= entry.duration - 30) return 0;
    return entry.position;
  }, [progressId]);
  // Refresh d'URL pour le lecteur : les liens signés des extracteurs expirent
  // (expiresInSeconds) — sans ce branchement, exhausted() du Player se termine
  // sur l'écran d'erreur sans pouvoir re-résoudre le flux. Dépend de la
  // fonction refetch (stable) plutôt que de l'objet query (neuf au fil des
  // statuts), sinon tous les callbacks/effets dépendants re-tournent en boucle.
  const refetchExternalPlay = playQuery.refetch;
  const refreshPlayUrl = useCallback(async (): Promise<boolean> => {
    try {
      const result = await refetchExternalPlay();
      return result.isSuccess;
    } catch {
      return false;
    }
  }, [refetchExternalPlay]);

  // Sélection pilotée par INDEX de la liste triée (VF prioritaire côté API) :
  // le clic Lecture part sur la source d'ordre 0 et descend la liste au besoin.
  const selectedIndexRef = useRef(0);
  selectedIndexRef.current = Math.min(selectedIndex, Math.max(0, activeSources.length - 1));
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
    else void refetchExternalPlay();
  }, [refetchExternalPlay]);

  // Déclaré avant les early-returns (React #310 : nombre de hooks stable).
  const startPlayback = useCallback((): void => {
    // Le clic Lecture part sur la source d'ordre 0 du contexte actif (épisode
    // choisi pour une série) : l'API trie déjà direct d'abord puis VF > VOSTFR
    // > default — c'est le « meilleur lecteur ».
    const source = activeSources[0];
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
    // Seule la position de CET épisode s'applique (legacy sans épisode = appliquée).
    const pos = resumePositionFor(activeEpisodeRef.current);
    setFailedRefs(new Set());
    setSkippedHost(null);
    setAutoSwitching(false);
    launchSource(source, pos);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [activeSources, launchSource, resumePositionFor]);

  // Changement de lecteur DEPUIS LE PLAYER (icône serveur) : même position
  // (relue du store, à ~5 s), sans passer par Lecture/Arrêter. Les sources
  // essayées repartent à zéro : c'est un choix explicite de l'utilisateur.
  const handleSourceChange = useCallback((sourceId: string): void => {
    const source = activeSources.find((candidate) => candidate.id === sourceId);
    if (!source) return;
    setSelectedIndex(activeSources.indexOf(source));
    setFailedRefs(new Set());
    setSkippedHost(null);
    setAutoSwitching(false);
    setIframeStarted(false);
    // Purge la résolution du lecteur précédent (playRef obsolète, jetons
    // à usage unique) pour éviter qu'un cache périmé serve au nouveau.
    for (const played of activeSources) {
      if (played.id !== sourceId) queryClient.removeQueries({ queryKey: ['x-play', played.host, played.playRef] });
    }
    launchSource(source, resumePositionFor(activeEpisodeRef.current));
  }, [activeSources, launchSource, queryClient, resumePositionFor]);

  const stopPlayback = useCallback((): void => {
    setRequestedRef(null);
    setIframeStarted(false);
    setFailedRefs(new Set());
    setSkippedHost(null);
    setAutoSwitching(false);
    if (selected) queryClient.removeQueries({ queryKey: ['x-play', selected.host, selected.playRef] });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [queryClient, selected]);

  // Reprise d'épisode : si une progression vise un épisode existant, on
  // restaure la sélection (l'ancien code retombait toujours sur l'épisode 1
  // avec la position d'un autre épisode).
  useEffect(() => {
    if (!isSeries || episodes.length === 0) return;
    const saved = useSettingsStore.getState().vodProgress[progressId]?.episode;
    if (saved == null || episodeNumber !== null) return;
    if (episodes.some((entry) => entry.number === saved)) setEpisodeNumber(saved);
  }, [isSeries, episodes, progressId, episodeNumber]);

  // Épisode suivant (tri croissant) pour l'enchaînement et le bouton dédié.
  const nextEpisode = useMemo(() => {
    if (activeEpisode === null) return null;
    const sorted = [...episodes].sort((a, b) => a.number - b.number);
    const index = sorted.findIndex((entry) => entry.number === activeEpisode);
    return index >= 0 ? (sorted[index + 1]?.number ?? null) : null;
  }, [episodes, activeEpisode]);
  const [seriesFinished, setSeriesFinished] = useState(false);
  // Garde anti-boucle : ne notifie que si l'état change vraiment.
  useEffect(() => { setSeriesFinished((value) => (value ? false : value)); }, [activeEpisode]);

  // Sélection douce (façon Netflix) : change l'épisode sans lancer la lecture.
  // Le bouton Lecture global joue ensuite la meilleure source de l'épisode actif.
  const selectEpisode = useCallback((episode: number): void => {
    setEpisodeNumber(episode);
    setSelectedIndex(0);
    setFailedRefs(new Set());
    setSkippedHost(null);
    setAutoSwitching(false);
    setIframeStarted(false);
    setSeriesFinished(false);
    if (selected) queryClient.removeQueries({ queryKey: ['x-play', selected.host, selected.playRef] });
  }, [queryClient, selected]);

  // Lecture immédiate d'un épisode depuis sa ligne (bouton play).
  const playEpisode = useCallback((episode: number): void => {
    const entry = episodes.find((candidate) => candidate.number === episode);
    const best = entry?.sources[0];
    if (!entry || !best) return;
    setEpisodeNumber(episode);
    setSelectedIndex(0);
    setFailedRefs(new Set());
    setSkippedHost(null);
    setAutoSwitching(false);
    setIframeStarted(false);
    setSeriesFinished(false);
    launchSource(best, resumePositionFor(episode));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [episodes, launchSource, resumePositionFor]);

  // Fin d'épisode (Player direct uniquement, l'iframe n'émet pas d'événement)
  // : marque Vu puis enchaîne le suivant, sinon affiche la fin de série.
  const handleEpisodeEnded = useCallback((): void => {
    const finished = activeEpisodeRef.current;
    if (finished === null) return;
    markVodEpisodeWatched(progressId, finished);
    useSettingsStore.getState().clearVodProgress(progressId);
    const sorted = [...episodes].sort((a, b) => a.number - b.number);
    const index = sorted.findIndex((entry) => entry.number === finished);
    const next = index >= 0 ? sorted[index + 1] : undefined;
    if (!next) {
      setRequestedRef(null);
      setIframeStarted(false);
      setSeriesFinished(true);
      return;
    }
    const best = next.sources[0];
    if (!best) return;
    setEpisodeNumber(next.number);
    setSelectedIndex(0);
    setFailedRefs(new Set());
    setSkippedHost(null);
    setAutoSwitching(false);
    setIframeStarted(false);
    launchSource(best, 0);
  }, [episodes, launchSource, markVodEpisodeWatched, progressId]);

  // Valeurs dérivées calculées AVANT les early-returns : playing et trailer
  // dépendent de requêtes, pas de `item` — et tout hook doit être appelé sur
  // CHAQUE render (React #310 : l'appeler après un return conditionnel fait
  // varier le nombre de hooks entre le render « chargement » et le render
  // « fiche », exactement le crash minifié #310).
  const directUrls = selected?.mode === 'direct' && requestedRef === selected.playRef ? playQuery.data?.urls ?? EMPTY_STRINGS : EMPTY_STRINGS;
  // Options lecteurs du Player : mémoïsées pour ne pas changer d'identité à
  // chaque render (re-renders Player en cascade).
  const playerSources = useMemo(
    () => activeSources.map(({ id, host, versions, mode }) => ({ id, host, versions, mode })),
    [activeSources],
  );
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
    const fallback = activeSources
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
    setSelectedIndex(activeSources.indexOf(fallback));
    positionAtSwitchRef.current = resumePositionFor(activeEpisodeRef.current);
    launchSource(fallback, positionAtSwitchRef.current);
  }, [requestedRef, selected, playQuery.isError, playQuery.isFetching, autoSwitching, activeSources, launchSource, resumePositionFor]);

  if (!id) return <EmptyState title="Contenu introuvable" />;
  if (detailQuery.isLoading) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (detailQuery.isError || !detailQuery.data) {
    return <EmptyState title="Contenu introuvable" hint="Ce titre n'est plus disponible dans le catalogue." />;
  }

  const item = detailQuery.data;
  const backdropUrl = item.backdropUrl ?? item.posterUrl;
  // Épisode en reprise + pourcentage pour la liste (legacy sans épisode = masqué).
  const progressEpisode = savedProgress && savedProgress.duration > 0 && savedProgress.position > 30 && savedProgress.position < savedProgress.duration - 30
    ? (savedProgress.episode ?? null)
    : null;
  const progressPct = progressEpisode !== null && savedProgress && savedProgress.duration > 0
    ? Math.min(99, Math.max(1, Math.round((savedProgress.position / savedProgress.duration) * 100)))
    : null;

  return (
    <div className="pb-10">
      <section className={playing ? 'relative z-0 -mt-px aspect-video w-full bg-black' : 'relative z-0 -mt-px h-[240px] sm:h-[340px] md:h-[400px] lg:h-[480px]'}>
        {playing ? (
          <div className="absolute inset-0 bg-black" data-player-chrome>
            {directUrls.length > 0 && selected ? (
              <Player
                key={`${selected.host}:${selected.playRef}`}
                urls={directUrls}
                title={activeEpisode !== null ? `${item.title} · E${activeEpisode}` : item.title}
                mode="vod"
                initialTime={startAt}
                onProgress={handleProgress}
                onEnded={activeEpisode !== null ? handleEpisodeEnded : undefined}
                onRefreshSource={refreshPlayUrl}
                sources={playerSources}
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
                <span className="rounded bg-white/15 px-2 py-0.5 font-bold uppercase tracking-wide backdrop-blur">{item.kind === 'SERIES' ? 'Série' : 'Film'}</span>
                {item.year != null && <span>{item.year}</span>}
                {activeEpisode !== null ? (
                  <span>Épisode {activeEpisode} · {activeSources.length} lecteur{activeSources.length > 1 ? 's' : ''}</span>
                ) : (
                  <span>{activeSources.length} lecteur{activeSources.length > 1 ? 's' : ''}</span>
                )}
              </div>
              <h1 className="mt-2 max-w-3xl text-3xl font-black leading-tight text-white [text-shadow:0_2px_10px_rgba(0,0,0,0.9),0_0_24px_rgba(0,0,0,0.65)] md:text-5xl">{item.title}</h1>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {activeSources.length > 0 && (
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
          {activeEpisode !== null && nextEpisode !== null && (
            <button type="button" className="btn btn-sm" onClick={() => playEpisode(nextEpisode)}>
              Épisode suivant · E{nextEpisode}
            </button>
          )}
          {skippedHost && (
            <span className="text-xs text-muted">
              Lecteur {skippedHost} indisponible{directFailed ? ' — lecteur source utilisé' : ' — lecteur suivant essayé'}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-right text-xs text-muted">
            {activeEpisode !== null ? `Épisode ${activeEpisode} · ` : ''}{item.title}
          </span>
        </div>
      )}
      {seriesFinished && (
        <div className="mx-auto w-full max-w-6xl px-4">
          <p className="mt-4 rounded-xl border border-border bg-surface p-4 text-sm text-muted">
            Dernier épisode terminé — bonne série ! Choisis un épisode ci-dessous pour le revoir.
          </p>
        </div>
      )}

      <div className="mx-auto w-full max-w-6xl px-4">
        {/* SÉRIES : liste d'épisodes façon Netflix (sans vignettes v1) — sous le
            hero, au-dessus des détails. Ligne = sélection douce, bouton play =
            lecture immédiate de la meilleure source de l'épisode. */}
        {isSeries && episodes.length > 0 && (
          <ExternalEpisodeList
            episodes={episodes}
            activeEpisode={activeEpisode}
            progressEpisode={progressEpisode}
            progressPct={progressPct}
            watched={watchedEpisodes}
            onSelect={selectEpisode}
            onPlay={playEpisode}
          />
        )}
        <div className="mt-4 md:hidden">
          <p className="text-lg font-bold leading-snug">{item.title}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {item.year != null && <span>{item.year}</span>}
            {activeEpisode !== null ? (
              <span>Épisode {activeEpisode} · {activeSources.length} lecteur{activeSources.length > 1 ? 's' : ''}</span>
            ) : (
              <span>{activeSources.length} lecteur{activeSources.length > 1 ? 's' : ''}</span>
            )}
          </div>
          {!playing && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {activeSources.length > 0 && (
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

        {/* Détails façon Netflix. Desktop : poster à gauche, colonne de
            contenu à droite. Mobile : PAS de poster (il occupait la moitié
            de l'écran pour rien) — la colonne prend toute la largeur, dans
            l'ordre Netflix : méta (genres + année + durée) → synopsis →
            répartition (réalisateur/acteurs) repliable. */}
        <div className="mt-4 flex flex-col gap-4 md:flex-row md:gap-6">
          {!playing && item.posterUrl && (
            <div className="hidden aspect-[2/3] w-44 shrink-0 overflow-hidden rounded-xl border border-border bg-surface shadow-lg md:block">
              <img src={item.posterUrl} alt={`Affiche de ${item.title}`} className="h-full w-full object-cover" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            {item.synopsis || (item.genres?.length ?? 0) > 0 || item.duration || item.director || item.cast || item.originalTitle ? (
              <>
                {/* Méta ligne 1 : genres en chips (scroll horizontal si
                    débordement — jamais de pile de chips sur 2 lignes mobile). */}
                {(item.genres?.length ?? 0) > 0 && (
                  <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0 [&::-webkit-scrollbar]:hidden">
                    {(item.genres ?? []).map((genre) => (
                      <span key={genre} className="shrink-0 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted">{genre}</span>
                    ))}
                  </div>
                )}
                {/* Méta ligne 2 : année · durée · titre original — la ligne
                    de faits que Netflix met juste au-dessus du synopsis. */}
                {(item.year != null || item.duration || item.originalTitle) && (
                  <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    {item.year != null && <span className="font-semibold text-foreground">{item.year}</span>}
                    {item.duration && <><span aria-hidden>·</span><span>{item.duration}</span></>}
                    {item.originalTitle && <><span aria-hidden>·</span><span>Titre original : <span className="italic">{item.originalTitle}</span></span></>}
                  </div>
                )}
                {item.synopsis && (
                  <>
                    <h2 className="mt-4 text-sm font-bold uppercase tracking-wide text-muted md:mt-5">Synopsis</h2>
                    <p className="mt-1.5 text-sm leading-relaxed md:text-[15px]">{item.synopsis}</p>
                  </>
                )}
                {/* Répartition (réalisateur/acteurs) : repliable sur mobile
                    (Netflix replie aussi le casting), ouverte par défaut en
                    desktop. Muselée à 3 noms quand repliée. */}
                {(item.director || item.cast) && (
                  <div className="mt-4 md:mt-5">
                    <button
                      type="button"
                      onClick={() => setCastOpen((value) => !value)}
                      className="flex w-full items-center justify-between gap-2 text-left md:pointer-events-none md:cursor-default"
                      aria-expanded={castOpen}
                    >
                      <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Distribution</h2>
                      <Icon.ChevronDown size={16} className={`text-muted transition-transform md:hidden ${castOpen ? 'rotate-180' : ''}`} aria-hidden />
                    </button>
                    <dl className={`mt-2 space-y-1.5 text-sm ${castOpen ? '' : 'hidden md:block'}`}>
                      {item.director && (
                        <div className="flex gap-2">
                          <dt className="w-24 shrink-0 text-xs text-muted md:w-28 md:text-sm">Réalisation</dt>
                          <dd className="min-w-0">{item.director}</dd>
                        </div>
                      )}
                      {item.cast && (
                        <div className="flex gap-2">
                          <dt className="w-24 shrink-0 text-xs text-muted md:w-28 md:text-sm">Acteurs</dt>
                          <dd className="min-w-0">{castOpen ? item.cast : item.cast.split(',').slice(0, 3).map((name) => name.trim()).join(', ')}</dd>
                        </div>
                      )}
                    </dl>
                  </div>
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
