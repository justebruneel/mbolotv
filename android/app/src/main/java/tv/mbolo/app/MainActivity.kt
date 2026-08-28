package tv.mbolo.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.Toast
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Enveloppe WebView de Mbolo TV.
 *
 * Décisions clés :
 *  - WebView **système** (jamais GeckoView : +70 Mo) avec accélération
 *    matérielle (activée par défaut + manifest) et cache HTTP LOAD_DEFAULT ;
 *    le service worker du site (prod) assure le shell hors ligne.
 *  - Immersif sticky : barres statut/navigation masquées en permanence.
 *  - Keep-screen-on : c'est une app vidéo, l'écran ne doit jamais s'éteindre
 *    en lecture — l'économie de batterie n'est pas prioritaire ici.
 *  - Plein écran vidéo : onShowCustomView/onHideCustomView, sinon le site
 *    retombe sur son pseudo plein écran.
 *  - Retour : plein écran → historique → double appui pour quitter.
 *  - Rotation : configChanges dans le manifest → l'Activity n'est pas
 *    recréée, la lecture ne se coupe jamais.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var fullscreenContainer: FrameLayout
    private lateinit var offlineOverlay: View
    private lateinit var progressBar: ProgressBar

    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var lastBackAt = 0L
    private var offlineByNetwork = false

    private val startHost: String by lazy { Uri.parse(BuildConfig.MBOLTV_URL).host ?: "" }

    private val networkMonitor = NetworkMonitor(
        onAvailable = ::onNetworkBack,
        onLost = ::onNetworkLost,
    )

    // ------------------------------- cycle de vie -------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.statusBarColor = Color.parseColor("#0f1419")
        window.navigationBarColor = Color.parseColor("#0f1419")
        hideSystemBars()
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webview)
        fullscreenContainer = findViewById(R.id.fullscreen_container)
        offlineOverlay = findViewById(R.id.offline_overlay)
        progressBar = findViewById(R.id.progress)

        // Beaucoup de box Android TV (AOSP, sans Play Store) n'ont AUCUN
        // provider WebView : l'écran de chargement serait à jamais blanc.
        // On détecte le composant avant de créer la WebView et on oriente
        // l'utilisateur, plutôt que de planter ou d'afficher du vide.
        if (!webViewProviderAvailable()) {
            showWebViewMissing()
            return
        }
        try {
            configureWebView()
        } catch (_: RuntimeException) {
            // Provider corrompu/verrouillé : même issue, expliquée à l'écran.
            showWebViewMissing()
            return
        }

        findViewById<Button>(R.id.retry_button).setOnClickListener {
            if (networkMonitor.isOnline()) {
                hideOffline()
                webView.reload()
            } else {
                Toast.makeText(this, R.string.still_offline, Toast.LENGTH_SHORT).show()
            }
        }

        networkMonitor.start(this)

        if (savedInstanceState != null) {
            // Rotation / restauration du process : reprend l'historique.
            webView.restoreState(savedInstanceState)
        } else {
            webView.loadUrl(BuildConfig.MBOLTV_URL)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        hideSystemBars()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        networkMonitor.stop()
        webView.apply {
            loadUrl("about:blank")
            removeAllViews()
            destroy()
        }
        super.onDestroy()
    }

    // ------------------------------- WebView -------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false // démarrage direct du direct
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportZoom(false)
            builtInZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
            // Suffixe UA : permet au site de détecter l'enveloppe native
            // (window.navigator.userAgent) sans modification du code web.
            userAgentString = "$userAgentString MboloTV/1.0 (Android; Mobile)"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        webView.setBackgroundColor(Color.parseColor("#0f1419"))
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true

        webView.addJavascriptInterface(
            NativeBridge(
                platform = "android-mobile",
                appVersion = { BuildConfig.VERSION_NAME },
                online = { networkMonitor.isOnline() },
                openExternalAction = { url -> runOnUiThread { openExternal(url) } },
                vibrateAction = { ms -> runOnUiThread { vibrate(ms) } },
                exit = { runOnUiThread { finish() } },
            ),
            "MboloNative",
        )

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val scheme = url.scheme ?: return false
                // Origin de l'app → WebView ; tout le reste (wa.me, YouTube,
                // mailto:, intent:, play store) → navigateur / app externe.
                if (scheme == "http" || scheme == "https") {
                    val host = url.host ?: return false
                    val sameSite = host == startHost || host.endsWith(".$startHost")
                    if (sameSite) return false
                }
                openExternal(url.toString())
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                // Uniquement si la page principale échoue ET que le réseau est
                // coupé (sinon le service worker du site gère déjà ses replis).
                if (request.isForMainFrame && !networkMonitor.isOnline()) showOffline()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progressBar.progress = newProgress
                progressBar.visibility = if (newProgress >= 100) View.GONE else View.VISIBLE
            }

            // Plein écran vidéo : le site appelle requestFullscreen() sur son
            // conteneur — Android route ça ici.
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) {
                    callback.onCustomViewHidden()
                    return
                }
                customView = view
                customViewCallback = callback
                fullscreenContainer.addView(
                    view,
                    ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
                )
                fullscreenContainer.visibility = View.VISIBLE
                webView.visibility = View.GONE
                hideSystemBars()
            }

            override fun onHideCustomView() {
                exitFullscreen()
            }
        }
    }

    // ------------------------------- retour / plein écran -------------------------------

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            customView != null -> exitFullscreen()
            webView.canGoBack() -> webView.goBack()
            else -> {
                // Double appui pour quitter : évite les sorties accidentelles
                // à la télécommande comme au doigt.
                val now = SystemClock.uptimeMillis()
                if (now - lastBackAt < 2_000) {
                    finish()
                } else {
                    lastBackAt = now
                    Toast.makeText(this, R.string.back_to_exit, Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun exitFullscreen() {
        val view = customView ?: return
        fullscreenContainer.removeView(view)
        fullscreenContainer.visibility = View.GONE
        webView.visibility = View.VISIBLE
        customView = null
        customViewCallback?.onCustomViewHidden()
        customViewCallback = null
        hideSystemBars()
    }

    // ------------------------------- réseau / hors ligne -------------------------------

    private fun onNetworkLost() {
        offlineByNetwork = true
        showOffline()
    }

    private fun onNetworkBack() {
        if (offlineByNetwork) {
            offlineByNetwork = false
            hideOffline()
            webView.reload()
        }
    }

    private fun showOffline() {
        offlineOverlay.visibility = View.VISIBLE
        progressBar.visibility = View.GONE
    }

    private fun hideOffline() {
        offlineOverlay.visibility = View.GONE
    }

    // ------------------------------- divers -------------------------------

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    // ------------------------------- webview systeme -------------------------------

    /** Un provider WebView est-il installé (Google webview, AOSP, Microsoft, …) ? */
    private fun webViewProviderAvailable(): Boolean {
        val pm = packageManager
        val providers = listOf(
            "com.google.android.webview",
            "com.android.webview",
            "com.google.android.webview.wbd",
            "com.microsoft.android.webview",
        )
        return providers.any { pkg ->
            try {
                pm.getPackageInfo(pkg, 0)
                true
            } catch (_: PackageManager.NameNotFoundException) {
                false
            }
        }
    }

    private fun showWebViewMissing() {
        findViewById<View>(R.id.webview_missing_overlay)?.visibility = View.VISIBLE
        findViewById<Button>(R.id.install_webview_button)?.setOnClickListener {
            openExternal("https://play.google.com/store/apps/details?id=com.google.android.webview")
        }
        findViewById<Button>(R.id.webview_retry_button)?.setOnClickListener {
            recreate()
        }
    }

    fun openExternal(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
        }
    }

    private fun vibrate(milliseconds: Long) {
        val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as? android.os.Vibrator ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(android.os.VibrationEffect.createOneShot(milliseconds, android.os.VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(milliseconds)
        }
    }
}
