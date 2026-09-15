package tv.mbolo.tv.core

/** Constantes du client natif — aucun secret serveur ici. */
object ApiConfig {
    /** Taille de page recommandée : 24–48, jamais de centaines d'éléments. */
    const val PAGE_SIZE = 24
    const val HOME_ROW_LIMIT = 12

    const val CONNECT_TIMEOUT_MS = 10_000L
    const val READ_TIMEOUT_MS = 15_000L
    /** Play URLs : pas de retry agressif, le serveur a déjà tout tenté. */
    const val PLAY_TIMEOUT_MS = 20_000L

    /** Cache HTTP disque OkHttp : réponses catalogue uniquement. */
    const val HTTP_CACHE_BYTES = 10L * 1024 * 1024

    /** TTL mémoire (ms) pour les données catalogue peu volatiles. */
    const val TTL_CATEGORIES_MS = 5 * 60_000L
    const val TTL_COUNTRIES_MS = 10 * 60_000L
    const val TTL_HOME_ROWS_MS = 5 * 60_000L
    /** Play URLs signées (expiry ~24h live, ~6h YouTube) : revalidation à 60s. */
    const val TTL_PLAY_MS = 60_000L
}
