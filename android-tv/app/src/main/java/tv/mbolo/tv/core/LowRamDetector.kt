package tv.mbolo.tv.core

import android.app.ActivityManager
import android.content.Context
import android.os.Build

/**
 * Détecteur low-RAM prudent : jamais un seul indicateur.
 * Priorité sur totalMem (1–1.5 Go = boîte très limitée), puis isLowRamDevice,
 * memoryClass, processeurs, version Android.
 */
object LowRamDetector {
    data class Profile(val lowRam: Boolean, val imageMemMb: Int, val prefetch: Int)

    fun profile(context: Context): Profile {
        val am = context.applicationContext.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mem = ActivityManager.MemoryInfo()
        try { am.getMemoryInfo(mem) } catch (_: Exception) {
        }
        val totalGb = mem.totalMem.toFloat() / (1024f * 1024f * 1024f)
        var score = 0
        if (am.isLowRamDevice) score += 2
        if (totalGb < 1.5f) score += 3 else if (totalGb < 2.5f) score += 1
        if (am.memoryClass <= 128) score += 1
        if (Runtime.getRuntime().availableProcessors() <= 4) score += 1
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) score += 1
        val low = score >= 3
        return if (low) {
            // Box 1–2 Go : caches et préchargement réduits, jamais la qualité vidéo.
            Profile(lowRam = true, imageMemMb = 32, prefetch = 0)
        } else {
            Profile(lowRam = false, imageMemMb = 96, prefetch = 2)
        }
    }
}