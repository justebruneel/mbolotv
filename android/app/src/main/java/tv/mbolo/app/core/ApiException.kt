package tv.mbolo.app.core

/** Erreur API typée — le corps distant n'est jamais logué en clair. */
class ApiException(
    val status: Int,
    val path: String,
    message: String,
) : Exception(message) {
    val isAccessDenied: Boolean get() = status == 403
    val isNotFound: Boolean get() = status == 404
    val isRateLimited: Boolean get() = status == 429
    val isServerError: Boolean get() = status >= 500
    val isUnavailable: Boolean get() = status == 451
}
