package tv.mbolo.app.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import tv.mbolo.app.R
import tv.mbolo.app.core.ApiClient
import tv.mbolo.app.core.DeviceStore
import tv.mbolo.app.core.MboloRepository
import tv.mbolo.app.core.PlayerController
import tv.mbolo.app.core.Telemetry

/**
 * Player natif plein écran (Media3/ExoPlayer).
 * 1 écran = 1 PlayerController = 1 ExoPlayer = 1 source active.
 * Lifecycle strict : release() sur onStop/onDestroy, jamais de player fantôme.
 * BACK : quitte le player (pas d'historique WebView).
 */
class PlayerActivity : ComponentActivity() {

    private lateinit var playerView: PlayerView
    private lateinit var loading: ProgressBar
    private lateinit var errorBox: View
    private lateinit var errorText: TextView
    private lateinit var controller: PlayerController
    private lateinit var vm: PlayerViewModel
    private lateinit var store: DeviceStore
    private lateinit var repo: MboloRepository

    private var kind: String = "channel"
    private var itemId: String = ""
    private var season: Int = -1
    private var episode: Int = -1
    private var host: String? = null
    private var playRef: String? = null
    private var collectJob: Job? = null
    private var progressJob: Job? = null
    private var heartbeatJob: Job? = null
    private var refreshedOnce = false
    private var currentUrl: String? = null
    private var resumeMs: Long = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_player)
        playerView = findViewById(R.id.player_view)
        loading = findViewById(R.id.player_loading)
        errorBox = findViewById(R.id.player_error_box)
        errorText = findViewById(R.id.player_error)

        kind = intent.getStringExtra(EXTRA_KIND) ?: "channel"
        itemId = intent.getStringExtra(EXTRA_ID).orEmpty()
        season = intent.getIntExtra(EXTRA_SEASON, -1)
        episode = intent.getIntExtra(EXTRA_EPISODE, -1)
        host = intent.getStringExtra(EXTRA_HOST)
        playRef = intent.getStringExtra(EXTRA_REF)

        store = DeviceStore(this)
        repo = MboloRepository(ApiClient(this, store))
        vm = ViewModelProvider(this, VmFactory(repo, store))[PlayerViewModel::class.java]
        controller = PlayerController(this)
        controller.listener = object : PlayerController.Listener {
            override fun onReady(firstFrame: Boolean) {
                loading.visibility = View.GONE
                if (firstFrame) Telemetry.event("player-first-frame")
            }

            override fun onError(fatal: Boolean, message: String) {
                showError(getString(R.string.cannot_play) + " ($message)")
            }
        }

        findViewById<Button>(R.id.player_retry).setOnClickListener { refreshAndPlay() }
        findViewById<Button>(R.id.player_close).setOnClickListener { finish() }

        // Reprise VOD : resolve() la fournit ; le polling ci-dessous la persiste.
        collectJob = lifecycleScope.launch {
            vm.state.collect { s ->
                when {
                    s.loading -> {
                        loading.visibility = View.VISIBLE
                        errorBox.visibility = View.GONE
                    }
                    s.accessRequired -> {
                        Toast.makeText(this@PlayerActivity, R.string.need_access, Toast.LENGTH_LONG).show()
                        finish()
                    }
                    s.externalOnly -> showError(s.error ?: getString(R.string.external_only))
                    s.error != null -> showError(s.error)
                    s.url != null -> {
                        currentUrl = s.url
                        resumeMs = s.resumeMs
                        errorBox.visibility = View.GONE
                        controller.prepare(s.url, s.resumeMs, true)
                        controller.attach(playerView)
                        startProgressSaver()
                        if (kind == "channel") heartbeat()
                    }
                }
            }
        }
        resolve()
    }

    private fun resolve() {
        refreshedOnce = false
        when (kind) {
            "channel" -> vm.playChannel(itemId)
            "vod" -> vm.playVod(itemId, season.takeIf { it >= 0 }, episode.takeIf { it >= 0 })
            "youtube" -> vm.playYoutube(itemId)
            "external" -> {
                val h = host
                val r = playRef
                if (h == null || r == null) vm.externalUnsupported() else vm.playExternal(h, r)
            }
            "external-iframe" -> vm.externalUnsupported()
        }
    }

    /** Retry léger : 1 refresh d'URL (expiry) puis 1 re-préparation, pas de boucle. */
    private fun refreshAndPlay() {
        if (!refreshedOnce) {
            refreshedOnce = true
            resolve()
        } else {
            if (!controller.retryOnce()) resolve()
        }
    }

    private fun showError(msg: String) {
        loading.visibility = View.GONE
        errorBox.visibility = View.VISIBLE
        errorText.text = msg
        findViewById<Button>(R.id.player_retry).requestFocus()
    }

    /** Persiste la reprise VOD toutes les 5s (jamais à chaque frame). */
    private fun startProgressSaver() {
        progressJob?.cancel()
        if (kind != "vod") return
        val key = PlayerViewModel.progressKey(itemId,
            season.takeIf { it >= 0 }, episode.takeIf { it >= 0 })
        progressJob = lifecycleScope.launch {
            while (true) {
                delay(5_000)
                val pos = controller.positionMs
                val dur = controller.durationMs
                if (pos > 0 && dur > 0) store.saveVodProgress(key, pos, dur)
            }
        }
    }

    private fun heartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = lifecycleScope.launch {
            repo.heartbeat(itemId)
            while (true) {
                delay(60_000)
                repo.heartbeat(itemId)
            }
        }
    }

    override fun onStop() {
        // Sauvegarde finale de la reprise avant release.
        if (kind == "vod") {
            val key = PlayerViewModel.progressKey(itemId,
                season.takeIf { it >= 0 }, episode.takeIf { it >= 0 })
            val pos = controller.positionMs
            val dur = controller.durationMs
            if (pos > 0 && dur > 0) store.saveVodProgress(key, pos, dur)
        }
        progressJob?.cancel()
        heartbeatJob?.cancel()
        controller.detach(playerView)
        controller.release()
        super.onStop()
    }

    override fun onDestroy() {
        collectJob?.cancel()
        progressJob?.cancel()
        heartbeatJob?.cancel()
        try {
            controller.detach(playerView)
            controller.release()
        } catch (_: Exception) {
        }
        super.onDestroy()
    }

    companion object {
        const val EXTRA_KIND = "kind" // channel | vod | youtube | external | external-iframe
        const val EXTRA_ID = "id"
        const val EXTRA_SEASON = "season"
        const val EXTRA_EPISODE = "episode"
        const val EXTRA_HOST = "host"
        const val EXTRA_REF = "ref"

        fun openChannel(c: Context, id: String) = c.startActivity(
            Intent(c, PlayerActivity::class.java)
                .putExtra(EXTRA_KIND, "channel").putExtra(EXTRA_ID, id),
        )

        fun openVod(c: Context, id: String, season: Int? = null, episode: Int? = null) {
            val i = Intent(c, PlayerActivity::class.java)
                .putExtra(EXTRA_KIND, "vod").putExtra(EXTRA_ID, id)
            if (season != null) i.putExtra(EXTRA_SEASON, season)
            if (episode != null) i.putExtra(EXTRA_EPISODE, episode)
            c.startActivity(i)
        }

        fun openYoutube(c: Context, id: String) = c.startActivity(
            Intent(c, PlayerActivity::class.java)
                .putExtra(EXTRA_KIND, "youtube").putExtra(EXTRA_ID, id),
        )

        fun openExternal(c: Context, host: String?, ref: String?) {
            val i = Intent(c, PlayerActivity::class.java).putExtra(EXTRA_ID, "")
            if (host.isNullOrBlank() || ref.isNullOrBlank()) {
                i.putExtra(EXTRA_KIND, "external-iframe")
            } else {
                i.putExtra(EXTRA_KIND, "external")
                    .putExtra(EXTRA_HOST, host).putExtra(EXTRA_REF, ref)
            }
            c.startActivity(i)
        }
    }
}
