package tv.mbolo.app.core

/**
 * Anti-rechargement : évite de refrapper l'API au retour sur un écran dont
 * les données sont encore fraîches (retour détail/player, re-création de vue).
 * Pur et testable en JVM (horloge injectée).
 */
class ScreenFreshness(private val ttlMs: Long = 60_000L) {
    private var key: String? = null
    private var at: Long = -1

    /** Vrai s'il faut recharger (clé différente ou TTL dépassé). */
    fun shouldReload(newKey: String, now: Long = System.currentTimeMillis()): Boolean {
        return newKey != key || at < 0 || now - at > ttlMs
    }

    fun markLoaded(newKey: String, now: Long = System.currentTimeMillis()) {
        key = newKey
        at = now
    }

    fun invalidate() {
        at = -1
    }
}
