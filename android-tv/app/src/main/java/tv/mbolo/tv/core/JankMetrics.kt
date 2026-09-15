package tv.mbolo.tv.core

import android.app.Activity
import android.view.Choreographer
import android.os.SystemClock

/**
 * Mesure du jank UI sans dépendance : comptage de frames via Choreographer.
 * Ne conserve que des agrégats bornés (aucun timestamp, aucune frame
 * unitaire) — le coût est un callback par frame redessinée, jamais une boucle.
 *
 * Détaché sur onDestroy : l'Activity est la seule source de vie du comptage,
 * donc aucune fuite même si le FrameCallback ne peut être enlevé (le noeud
 * est référencé par Choreographer tant que l'UI vit, puis collecté).
 */
object JankMetrics {
    @Volatile private var totalFrames = 0L
    @Volatile private var jankyFrames = 0L
    @Volatile private var reportedMs = 0L

    private val frameMs = 1_000L / 60L

    private val callback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (reportedMs == 0L) reportedMs = SystemClock.uptimeMillis()
            val delta = SystemClock.uptimeMillis() - reportedMs
            reportedMs = SystemClock.uptimeMillis()
            totalFrames += 1
            if (delta > frameMs * 2) jankyFrames += 1
            Choreographer.getInstance().postFrameCallback(this)
        }
    }

    fun attach(activity: Activity) {
        try {
            Choreographer.getInstance().postFrameCallback(callback)
        } catch (_: Exception) {
        }
    }

    fun snapshot(): String {
        val (total, janky) = counts()
        val pct = if (total == 0L) 0 else (janky * 100L) / total
        return "frames=$total jank=$janky($pct%)"
    }

    fun counts(): Pair<Long, Long> = totalFrames to jankyFrames
}