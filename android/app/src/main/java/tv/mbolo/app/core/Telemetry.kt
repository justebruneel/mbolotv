package tv.mbolo.app.core

/**
 * Télémétrie native légère et bornée (100 entrées max, mémoire seule).
 * Ne journalise JAMAIS : token, mot de passe, deviceId, IP, URL signée.
 * Horloge = temps wall (testable en JVM, sans stub Android).
 */
object Telemetry {
    var coldStartMs: Long = -1
        private set
    var firstScreenMs: Long = -1
        private set

    private val apiLatencies = ArrayDeque<Long>()
    private val events = ArrayDeque<String>()

    @Volatile var networkKind: String = "unknown"
    @Volatile private var totalFrames = 0L
    @Volatile private var jankyFrames = 0L

    private val appStart = now()

    private fun now(): Long = System.currentTimeMillis()

    fun markColdStart() {
        if (coldStartMs < 0) coldStartMs = now() - appStart
    }

    fun markFirstScreen() {
        if (firstScreenMs < 0) firstScreenMs = now() - appStart
    }

    @Synchronized
    fun apiLatency(ms: Long) {
        apiLatencies.addLast(ms)
        if (apiLatencies.size > 100) apiLatencies.removeFirst()
    }

    @Synchronized
    fun jank(frames: Long, janky: Long) {
        totalFrames = frames
        jankyFrames = janky
    }

    @Synchronized
    fun event(name: String) {
        // Noms d'événements seuls, sans paramètre sensible.
        events.addLast("$name@${now() - appStart}ms")
        if (events.size > 100) events.removeFirst()
    }

    @Synchronized
    fun snapshot(): String {
        val avg = if (apiLatencies.isEmpty()) -1 else apiLatencies.average().toLong()
        val pct = if (totalFrames == 0L) 0 else (jankyFrames * 100L) / totalFrames
        return "cold=${coldStartMs}ms first=${firstScreenMs}ms apiAvg=${avg}ms " +
            "apiN=${apiLatencies.size} net=$networkKind " +
            "frames=$totalFrames jank=$jankyFrames($pct%) " +
            "events=[${events.takeLast(10).joinToString(",")}]"
    }
}