package tv.mbolo.app.ui

import android.content.Context
import android.widget.ImageView
import coil3.ImageLoader
import coil3.disk.DiskCache
import coil3.memory.MemoryCache
import coil3.request.CachePolicy
import coil3.request.Disposable
import coil3.request.ImageRequest
import coil3.request.placeholder
import coil3.request.target
import coil3.size.Precision
import okio.Path.Companion.toOkioPath
import tv.mbolo.app.core.LowRamDetector

/**
 * Images natives (Coil 3) : redimensionnées au composant, caches bornés.
 * - Jamais de pleine résolution : `size(px,px)` = taille d'affichage.
 * - Mémoire : profil low-RAM (32 Mo) vs standard (96 Mo, plafonné).
 * - Disque : 50 Mo, survit au redémarrage.
 * - Requêtes hors écran annulées par le recyclage RecyclerView (Disposable).
 * - Bas-résolution sur appareils limités : rgb565 + precision inexact
 *   réduit la mémoire RAM et le coût CPU de décodage (Android TV boîtes 1 Go).
 */
object NativeImages {
    @Volatile private var lowRam = false
    @Volatile private var loader: ImageLoader? = null

    private fun app(context: Context) = context.applicationContext

    fun configure(context: Context) {
        lowRam = LowRamDetector.profile(app(context)).lowRam
    }

    fun loader(context: Context): ImageLoader {
        return loader ?: synchronized(this) {
            loader ?: build(context).also { loader = it }
        }
    }

    private fun build(context: Context): ImageLoader {
        val app = app(context)
        return ImageLoader.Builder(app)
            .memoryCache {
                MemoryCache.Builder()
                    .maxSizeBytes((if (lowRam) 32 else 96).toLong() * 1024 * 1024)
                    .strongReferencesEnabled(true)
                    .build()
            }
            .diskCache {
                DiskCache.Builder()
                    .directory(app.cacheDir.resolve("images").toOkioPath())
                    .maxSizeBytes(50L * 1024 * 1024)
                    .build()
            }
            .memoryCachePolicy(CachePolicy.ENABLED)
            .diskCachePolicy(CachePolicy.ENABLED)
            .build()
    }

    /** Charge `url` redimensionnée à (w×h px). Retourne le Disposable (recyclage). */
    fun load(view: ImageView, url: String?, wPx: Int, hPx: Int, placeholder: Int = 0): Disposable? {
        val ctx = view.context
        if (url.isNullOrBlank()) {
            if (placeholder != 0) view.setImageResource(placeholder)
            else view.setImageDrawable(null)
            return null
        }
        val req = ImageRequest.Builder(ctx)
            .data(url)
            .target(view)
            .size(wPx.coerceAtLeast(1), hPx.coerceAtLeast(1))
            .memoryCachePolicy(CachePolicy.ENABLED)
            .diskCachePolicy(CachePolicy.ENABLED)
            .apply {
                if (lowRam) precision(Precision.INEXACT)
            }
            .apply { if (placeholder != 0) placeholder(placeholder) }
            .build()
        return loader(ctx).enqueue(req)
    }
}