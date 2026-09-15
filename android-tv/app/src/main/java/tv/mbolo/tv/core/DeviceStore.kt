package tv.mbolo.tv.core

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

/**
 * DeviceStore — persistance locale (SharedPreferences, pas de DataStore pour
 * garder l'APK minimal sur les box 1 Go : même garanties de survie
 * fermeture / reboot / mise à jour, sans protobuf).
 *
 * Contenu : deviceId (UUID anonyme, généré UNE fois), dataSaver, historique
 * local, reprise VOD. Aucune donnée personnelle.
 */
class DeviceStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("mbolo-native", Context.MODE_PRIVATE)

    /** UUID persistant envoyé en `x-device-id`. Jamais régénéré. */
    @Synchronized
    fun deviceId(): String {
        val existing = prefs.getString(KEY_DEVICE_ID, null)
        if (existing != null) return existing
        val created = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_DEVICE_ID, created).apply()
        return created
    }

    var dataSaver: Boolean
        get() = prefs.getBoolean(KEY_DATA_SAVER, false)
        set(v) = prefs.edit().putBoolean(KEY_DATA_SAVER, v).apply()

    // ---- Reprise VOD locale : vodId -> "positionMs|durationMs|updatedAt" ----
    fun saveVodProgress(id: String, positionMs: Long, durationMs: Long) {
        if (durationMs <= 0 || positionMs < 0) return
        // Comportement web : proche de la fin (<30s restantes) = terminé → 0.
        val pos = if (durationMs - positionMs < 30_000) 0L else positionMs
        prefs.edit().putString(KEY_VOD + id, "$pos|$durationMs|${System.currentTimeMillis()}").apply()
    }

    fun vodProgress(id: String): Long {
        val raw = prefs.getString(KEY_VOD + id, null) ?: return 0L
        return raw.substringBefore("|").toLongOrNull() ?: 0L
    }

    // ---- Historique local borné (50 entrées max, pas de backend) ----
    fun pushHistory(entry: String) {
        val cur = prefs.getStringSet(KEY_HISTORY, emptySet())?.toMutableSet() ?: mutableSetOf()
        // Supprime toute occurrence antérieure du même contenu (même si le
        // timestamp préfixe diffère), sinon un même lien s'accumule.
        cur.removeAll { it.endsWith("|$entry") }
        cur.add("${System.currentTimeMillis()}|$entry")
        val trimmed = cur.sorted().takeLast(MAX_HISTORY).toSet()
        prefs.edit().putStringSet(KEY_HISTORY, trimmed).apply()
    }

    fun history(): List<String> =
        (prefs.getStringSet(KEY_HISTORY, emptySet()) ?: emptySet()).sortedDescending()

    private companion object {
        const val KEY_DEVICE_ID = "device-id"
        const val KEY_DATA_SAVER = "data-saver"
        const val KEY_VOD = "vod-progress:"
        const val KEY_HISTORY = "history"
        const val MAX_HISTORY = 50
    }
}
