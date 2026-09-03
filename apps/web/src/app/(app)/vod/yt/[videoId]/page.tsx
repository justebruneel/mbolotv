'use client';

import { EmptyState, Icon, Spinner } from '@mbolo/ui';
import { useParams } from 'next/navigation';
import { Suspense, useEffect, useMemo } from 'react';
import { useYoutubeVideo } from '../../../../../shared/api/queries';
import { useSettingsStore } from '../../../../../shared/stores/settings';
import { useVodPlayerStore } from '../../../../../shared/stores/player';
import { useYoutubeFavoritesStore, youtubeProgressId } from '../../../../../shared/stores/youtubeFavorites';
import { FavoriteButton } from '@mbolo/ui';
import { YoutubePlayer } from '../../../../../features/vod/components/YoutubePlayer';

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function YoutubeDetailContent() {
  const params = useParams<{ videoId: string }>();
  const videoId = typeof params.videoId === 'string' ? params.videoId : '';
  const itemQuery = useYoutubeVideo(videoId, Boolean(videoId));

  const progressId = useMemo(() => youtubeProgressId(videoId), [videoId]);
  const isFavorite = useYoutubeFavoritesStore((state) => state.ids.includes(progressId));
  const toggleFavorite = useYoutubeFavoritesStore((state) => state.toggle);
  const progress = useSettingsStore((state) => state.vodProgress[progressId]);
  const clearVod = useVodPlayerStore((state) => state.clearVod);

  // Cette fiche a son propre lecteur : libérer le mini-lecteur VOD éventuel
  // pour ne pas superposer deux lectures (GlobalPlayer ne connaît pas les ids yt:).
  useEffect(() => { clearVod(); }, [clearVod]);

  if (!videoId) return <EmptyState title="Contenu introuvable" />;
  if (itemQuery.isLoading) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (itemQuery.isError || !itemQuery.data) return <EmptyState title="Contenu introuvable" hint="Cette vidéo n'est plus disponible." />;

  const item = itemQuery.data;
  const startAt = progress && progress.position > 30 && progress.duration > 0 ? progress.position : 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-10">
      <div className="aspect-video w-full overflow-hidden rounded-xl bg-black">
        <YoutubePlayer videoId={item.id} title={item.title} posterUrl={item.posterUrl} startAt={startAt} />
      </div>

      <div className="mt-5 flex flex-col gap-5 sm:flex-row">
        <div className="w-32 shrink-0 sm:w-44">
          <div className="aspect-video overflow-hidden rounded-lg border border-border bg-surface">
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
              onToggle={() => toggleFavorite(progressId)}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="rounded-md bg-surface px-2 py-0.5 font-semibold">Nollywood · YouTube</span>
            {item.publishedAt && <span>Publié le {new Date(item.publishedAt).toLocaleDateString('fr-FR')}</span>}
            {item.duration !== null && item.duration > 0 && <span>{formatTime(item.duration)}</span>}
          </div>

          {progress && progress.duration > 0 && progress.position > 30 && (
            <div className="mt-3 max-w-sm">
              <div className="h-1 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full bg-accent" style={{ width: `${Math.min(100, (progress.position / progress.duration) * 100)}%` }} />
              </div>
              <p className="mt-1 text-xs text-muted">Reprise à {formatTime(progress.position)} · {Math.round((progress.position / Math.max(1, progress.duration)) * 100)} % vus</p>
            </div>
          )}

          {item.description && (
            <p className="mt-4 whitespace-pre-line text-sm text-muted">{item.description.slice(0, 800)}{item.description.length > 800 ? '…' : ''}</p>
          )}
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
