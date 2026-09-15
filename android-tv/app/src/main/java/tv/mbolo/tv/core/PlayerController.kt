package tv.mbolo.tv.core

import android.content.Context
import android.os.SystemClock
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.datasource.DefaultHttpDataSource

/**
 * PlayerController — 1 écran Player = 1 controller = 1 ExoPlayer = 1 source.
 * Mécanismes natifs Media3 uniquement : pas d'ABR maison, pas de buffer manager.
 * Formats : HLS (.m3u8), MP4 progressif, TS progressif (.ts Stalker).
 * L'URL signée backend est utilisée telle quelle (jamais reconstruite).
 */
@OptIn(UnstableApi::class)
class PlayerController(private val context: Context) {

    data class Stats(
        var prepareAt: Long = 0,
        var firstFrameAt: Long = -1,
        var rebufferCount: Int = 0,
        var rebufferMs: Long = 0,
        var lastStallAt: Long = -1,
        var videoWidth: Int = 0,
        var videoHeight: Int = 0,
    )

    interface Listener {
        fun onReady(firstFrame: Boolean) {}
        fun onEnded() {}
        fun onError(fatal: Boolean, message: String) {}
    }

    var listener: Listener? = null
    val stats = Stats()
    private var player: ExoPlayer? = null
    private var lastUrl: String? = null

    val isPlaying: Boolean get() = player?.isPlaying == true
    val positionMs: Long get() = player?.currentPosition ?: 0L
    val durationMs: Long get() = player?.duration?.takeIf { it > 0 } ?: 0L

    /** Prépare + démarre. `startAt` = reprise VOD locale (0 = début). */
    @OptIn(UnstableApi::class)
    fun prepare(url: String, startAt: Long = 0, playWhenReady: Boolean = true) {
        release()
        stats.prepareAt = SystemClock.uptimeMillis()
        stats.firstFrameAt = -1
        lastUrl = url
        val http = DefaultHttpDataSource.Factory()
            .setConnectTimeoutMs(ApiConfig.CONNECT_TIMEOUT_MS.toInt())
            .setReadTimeoutMs(ApiConfig.READ_TIMEOUT_MS.toInt())
            .setAllowCrossProtocolRedirects(true)
        val p = ExoPlayer.Builder(context)
            .setMediaSourceFactory(
                DefaultMediaSourceFactory(context)
                    .setDataSourceFactory(http),
            )
            .build()
        player = p
        val lower = url.lowercase().substringBefore("?")
        val item = MediaItem.fromUri(url)
        // HLS vs progressif (MP4/TS) : Media3 choisit l'extracteur adapté.
        // HlsMediaSource explicite pour les .m3u8 (live + VOD HLS externes).
        if (lower.endsWith(".m3u8")) {
            p.setMediaSource(HlsMediaSource.Factory(http).createMediaSource(item))
        } else {
            p.setMediaSource(ProgressiveMediaSource.Factory(http).createMediaSource(item))
        }
        p.addListener(object : Player.Listener {
            override fun onRenderedFirstFrame() {
                if (stats.firstFrameAt < 0) {
                    stats.firstFrameAt = SystemClock.uptimeMillis()
                    listener?.onReady(true)
                }
            }

            override fun onPlaybackStateChanged(state: Int) {
                when (state) {
                    Player.STATE_READY -> listener?.onReady(false)
                    Player.STATE_ENDED -> listener?.onEnded()
                    Player.STATE_BUFFERING -> {
                        if (stats.lastStallAt < 0) stats.lastStallAt = SystemClock.uptimeMillis()
                    }
                    Player.STATE_IDLE -> Unit
                }
                if (state == Player.STATE_READY && stats.lastStallAt >= 0) {
                    // Premier READY après prepare avec firstFrame = démarrage,
                    // pas un rebuffer : on ne compte que les stalls ultérieurs.
                    if (stats.firstFrameAt >= 0) {
                        stats.rebufferCount += 1
                        stats.rebufferMs += SystemClock.uptimeMillis() - stats.lastStallAt
                    }
                    stats.lastStallAt = -1
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                listener?.onError(false, error.errorCodeName ?: "player-error")
            }

            override fun onVideoSizeChanged(videoSize: androidx.media3.common.VideoSize) {
                stats.videoWidth = videoSize.width
                stats.videoHeight = videoSize.height
            }
        })
        if (startAt > 0) p.seekTo(startAt)
        p.playWhenReady = playWhenReady
        p.prepare()
    }

    fun play() { player?.play() }
    fun pause() { player?.pause() }
    fun seekTo(ms: Long) { player?.seekTo(ms) }

    fun attach(view: androidx.media3.ui.PlayerView) {
        view.player = player
    }

    fun detach(view: androidx.media3.ui.PlayerView) {
        if (view.player === player) view.player = null
    }

    /** Retry léger : 1 re-préparation de la même URL (appelant : refresh d'abord). */
    fun retryOnce(): Boolean {
        val url = lastUrl ?: return false
        val pos = positionMs
        prepare(url, pos, true)
        return true
    }

    fun startupMs(): Long =
        if (stats.firstFrameAt >= 0) stats.firstFrameAt - stats.prepareAt else -1

    /** Libération systématique (onStop/onDestroy) : jamais de player fantôme. */
    fun release() {
        try {
            player?.stop()
            player?.release()
        } catch (_: Exception) {
        }
        player = null
    }
}
