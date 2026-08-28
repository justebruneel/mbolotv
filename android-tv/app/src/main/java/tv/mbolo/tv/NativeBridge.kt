package tv.mbolo.tv

import android.webkit.JavascriptInterface

/**
 * Pont Web ↔ Android v1 — exposé au site sous `window.MboloNative`.
 *
 * Contrat minimal versionné :
 *   getBridgeVersion() -> 1
 *   getPlatform()      -> "android-mobile" | "android-tv"
 *   getAppVersion()    -> "1.0.0"
 *   isOnline()         -> Boolean
 *   openExternal(url)  -> ouvre le navigateur / app externe
 *   vibrate(ms)        -> retour haptique
 *   exitApp()          -> ferme l'enveloppe
 *
 * Règles : ne jamais retirer de méthode (casse le site déployé), n'ajouter
 * qu'en fin de classe et incrémenter getBridgeVersion(). Aucune donnée
 * sensible ne traverse ce pont ; le WebView ne charge que MBOLTV_URL.
 * Côté site, un simple `window.MboloNative?.getPlatform()` suffit — pas
 * d'erreur dans un navigateur classique (undefined).
 */
class NativeBridge(
    private val platform: String,
    private val appVersion: () -> String,
    private val online: () -> Boolean,
    private val openExternalAction: (String) -> Unit,
    private val vibrateAction: (Long) -> Unit,
    private val exit: () -> Unit,
) {
    @JavascriptInterface
    fun getBridgeVersion(): Int = 1

    @JavascriptInterface
    fun getPlatform(): String = platform

    @JavascriptInterface
    fun getAppVersion(): String = appVersion()

    @JavascriptInterface
    fun isOnline(): Boolean = online()

    @JavascriptInterface
    fun openExternal(url: String) {
        openExternalAction(url)
    }

    @JavascriptInterface
    fun vibrate(milliseconds: Long) {
        vibrateAction(milliseconds)
    }

    @JavascriptInterface
    fun exitApp() = exit()
}
