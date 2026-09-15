package tv.mbolo.tv

import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import tv.mbolo.tv.core.ApiClient
import tv.mbolo.tv.core.ApiException
import tv.mbolo.tv.core.DeviceStore
import tv.mbolo.tv.core.JankMetrics
import tv.mbolo.tv.core.LowRamDetector
import tv.mbolo.tv.core.MboloRepository
import tv.mbolo.tv.core.NetworkInfo
import tv.mbolo.tv.core.Telemetry
import tv.mbolo.tv.core.TileUi
import tv.mbolo.tv.ui.AccessViewModel
import tv.mbolo.tv.ui.BrowseMode
import tv.mbolo.tv.ui.BrowseViewModel
import tv.mbolo.tv.ui.HomeRowAdapter
import tv.mbolo.tv.ui.HomeViewModel
import tv.mbolo.tv.ui.NativeImages
import tv.mbolo.tv.ui.PlayerActivity
import tv.mbolo.tv.ui.PlayerViewModel
import tv.mbolo.tv.ui.TileAdapter
import tv.mbolo.tv.ui.VmFactory

/**
 * Shell natif (Phase 5) : AUCUNE WebView pour l'interface principale.
 * Écrans : Accueil / Chaînes / Films / Séries / Favoris / Recherche / Paramètres.
 * Chaque écran annule ses jobs à la sortie (pas de callback sur vue détruite).
 * L'ancien wrapper WebView reste accessible via "Secours web" (fallback temporaire).
 */
class MainActivity : ComponentActivity() {

    private lateinit var store: DeviceStore
    private lateinit var repo: MboloRepository
    private lateinit var factory: VmFactory
    private lateinit var container: FrameLayout
    private lateinit var offlineBanner: View
    private lateinit var monitor: NetworkMonitor

    private var screenJob: Job? = null
    private val backStack = ArrayDeque<Screen>()
    private var current: Screen = Screen.HOME
    private var lastRv: RecyclerView? = null
    /** Position verticale de l'écran au moment où on le quitte (restitution). */
    private val scrollPos = hashMapOf<Screen, Int>()

    private var homeVm: HomeViewModel? = null
    private var browseVm: BrowseViewModel? = null

    private enum class Screen { HOME, CHANNELS, MOVIES, SERIES, FAVORITES, YOUTUBE, EXTERNAL, SEARCH, SETTINGS }

    private val imgW: Int by lazy { (148 * resources.displayMetrics.density).toInt() }
    private val imgH: Int by lazy { (84 * resources.displayMetrics.density).toInt() }
    private val gridSpan: Int by lazy {
        if (resources.configuration.smallestScreenWidthDp >= 600) 5 else 3
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Telemetry.markColdStart()
        setContentView(R.layout.activity_main)

        store = DeviceStore(this)
        repo = MboloRepository(ApiClient(this, store))
        factory = VmFactory(repo, store)
        container = findViewById(R.id.content_container)
        offlineBanner = findViewById(R.id.offline_banner)
        NativeImages.configure(this)
        JankMetrics.attach(this)
        try {
            Telemetry.networkKind = NetworkInfo.current(this).name.lowercase()
        } catch (_: Exception) {
        }

        monitor = NetworkMonitor(
            onAvailable = { offlineBanner.visibility = View.GONE },
            onLost = { offlineBanner.visibility = View.VISIBLE },
        )
        monitor.start(this)
        findViewById<Button>(R.id.offline_retry).setOnClickListener {
            if (monitor.isOnline()) {
                offlineBanner.visibility = View.GONE
                show(current)
            } else {
                Toast.makeText(this, R.string.still_offline, Toast.LENGTH_SHORT).show()
            }
        }
        findViewById<Button>(R.id.btn_legacy).setOnClickListener { openLegacy() }

        bindNav(R.id.nav_home, Screen.HOME)
        bindNav(R.id.nav_channels, Screen.CHANNELS)
        bindNav(R.id.nav_movies, Screen.MOVIES)
        bindNav(R.id.nav_series, Screen.SERIES)
        bindNav(R.id.nav_favorites, Screen.FAVORITES)
        bindNav(R.id.nav_youtube, Screen.YOUTUBE)
        bindNav(R.id.nav_external, Screen.EXTERNAL)
        bindNav(R.id.nav_search, Screen.SEARCH)
        bindNav(R.id.nav_settings, Screen.SETTINGS)

        if (savedInstanceState == null) show(Screen.HOME)
        else show(current)
    }

    private fun bindNav(id: Int, s: Screen) {
        findViewById<Button>(id).setOnClickListener { open(s) }
    }

    private fun open(s: Screen) {
        if (s != current) backStack.addLast(current)
        show(s)
    }

    private fun rememberScroll() {
        val rv = lastRv ?: return
        val p = (rv.layoutManager as? LinearLayoutManager)?.findFirstVisibleItemPosition() ?: 0
        if (p > 0) scrollPos[current] = p
        lastRv = null
    }

    /** Restaure la position mémorisée pour la grille (une seule fois par retour). */
    private fun restoreScroll(rv: RecyclerView, key: Screen, adapter: RecyclerView.Adapter<*>) {
        val saved = scrollPos.remove(key) ?: return
        if (saved > 0 && saved < adapter.itemCount) {
            (rv.layoutManager as? LinearLayoutManager)?.scrollToPositionWithOffset(saved, 0)
        }
    }

    private fun show(s: Screen) {
        rememberScroll()
        // Sortie d'écran : on annule le travail réseau encore en vol de l'écran
        // précédent (Wi-Fi lent : pas de requêtes fantômes qui tiennent des sockets).
        when (current) {
            Screen.HOME -> homeVm?.cancel()
            Screen.CHANNELS, Screen.MOVIES, Screen.SERIES, Screen.FAVORITES,
            Screen.YOUTUBE, Screen.EXTERNAL -> browseVm?.cancel()
            else -> Unit
        }
        current = s
        screenJob?.cancel()
        container.removeAllViews()
        when (s) {
            Screen.HOME -> showHome()
            Screen.CHANNELS -> showBrowse(BrowseMode.CHANNELS, "Chaînes")
            Screen.MOVIES -> showBrowse(BrowseMode.MOVIES, "Films")
            Screen.SERIES -> showBrowse(BrowseMode.SERIES, "Séries")
            Screen.FAVORITES -> showBrowse(BrowseMode.FAVORITES, "Favoris")
            Screen.YOUTUBE -> showBrowse(BrowseMode.YOUTUBE, "YouTube")
            Screen.EXTERNAL -> showBrowse(BrowseMode.EXTERNAL, "Externe")
            Screen.SEARCH -> showSearch()
            Screen.SETTINGS -> showSettings(null)
        }
    }

    // ------------------------------- Accueil -------------------------------
    private fun showHome() {
        val v = LayoutInflater.from(this).inflate(R.layout.screen_home, container, false)
        container.addView(v)
        val rows: RecyclerView = v.findViewById(R.id.home_rows)
        val state: View = v.findViewById(R.id.home_state)
        val status: TextView = v.findViewById(R.id.home_status)
        rows.layoutManager = LinearLayoutManager(this, LinearLayoutManager.VERTICAL, false)
        rows.setHasFixedSize(true)
        lastRv = rows
        val pool = RecyclerView.RecycledViewPool()
        val prefetch = LowRamDetector.profile(this).prefetch
        // Adapter créé UNE fois par rendu d'écran : subList diffère, on ne
        // recrée jamais la stack de vues à chaque état (jank au retour).
        val adapter = HomeRowAdapter(imgW, imgH, pool, prefetch, ::onTile)
        rows.adapter = adapter
        val vm = ViewModelProvider(this, factory)[HomeViewModel::class.java]
        homeVm = vm
        screenJob = lifecycleScope.launch {
            vm.state.collect { s ->
                if (s.accessRequired) {
                    showSettings(getString(R.string.need_access))
                    screenJob?.cancel()
                    return@collect
                }
                if (s.loading) {
                    if (s.rows.isEmpty()) {
                        state.visibility = View.VISIBLE
                        status.text = getString(R.string.loading)
                    }
                    v.findViewById<Button>(R.id.home_retry).visibility = View.GONE
                } else if (s.error != null) {
                    state.visibility = View.VISIBLE
                    status.text = s.error
                    v.findViewById<Button>(R.id.home_retry).visibility = View.VISIBLE
                } else {
                    state.visibility = View.GONE
                    adapter.submitList(s.rows.map { tv.mbolo.tv.ui.HomeRowUi(it.title, it.tiles) })
                    restoreScroll(rows, current, adapter)
                    Telemetry.markFirstScreen()
                    Telemetry.event("home-ok")
                }
            }
        }
        v.findViewById<Button>(R.id.home_retry).setOnClickListener { vm.load(force = true) }
        vm.load()
    }

    // ------------------------------- Grilles paginées -------------------------------
    private fun showBrowse(mode: BrowseMode, title: String) {
        val v = LayoutInflater.from(this).inflate(R.layout.screen_browse, container, false)
        container.addView(v)
        val grid: RecyclerView = v.findViewById(R.id.browse_grid)
        val status: TextView = v.findViewById(R.id.browse_status)
        val more: ProgressBar = v.findViewById(R.id.browse_more)
        val lm = GridLayoutManager(this, gridSpan)
        grid.layoutManager = lm
        grid.setHasFixedSize(true)
        val adapter = TileAdapter(imgW, imgH, ::onTile)
        grid.adapter = adapter
        lastRv = grid
        val vm = ViewModelProvider(this, factory)[BrowseViewModel::class.java]
        browseVm = vm
        grid.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(r: RecyclerView, dx: Int, dy: Int) {
                if (dy <= 0) return
                if (lm.findLastVisibleItemPosition() >= adapter.itemCount - 6) vm.loadMore()
            }
        })
        screenJob = lifecycleScope.launch {
            vm.state.collect { s ->
                if (s.accessRequired) {
                    showSettings(getString(R.string.need_access))
                    screenJob?.cancel()
                    return@collect
                }
                more.visibility = if (s.loadingMore) View.VISIBLE else View.GONE
                if (s.loading) {
                    if (s.items.isEmpty()) {
                        status.visibility = View.VISIBLE
                        status.text = "$title — ${getString(R.string.loading)}"
                    }
                } else if (s.error != null && s.items.isEmpty()) {
                    status.visibility = View.VISIBLE
                    status.text = s.error
                } else {
                    status.visibility = View.GONE
                    adapter.submitList(s.items.toList())
                    if (s.items.isEmpty()) {
                        status.visibility = View.VISIBLE
                        status.text = getString(R.string.empty_here)
                    }
                    restoreScroll(grid, current, adapter)
                    Telemetry.markFirstScreen()
                }
            }
        }
        vm.load(mode)
    }

    // ------------------------------- Recherche -------------------------------
    private fun showSearch() {
        val v = LayoutInflater.from(this).inflate(R.layout.screen_search, container, false)
        container.addView(v)
        val input: EditText = v.findViewById(R.id.search_input)
        val grid: RecyclerView = v.findViewById(R.id.search_grid)
        val status: TextView = v.findViewById(R.id.search_status)
        grid.layoutManager = GridLayoutManager(this, gridSpan)
        grid.setHasFixedSize(true)
        val adapter = TileAdapter(imgW, imgH, ::onTile)
        grid.adapter = adapter
        Telemetry.markFirstScreen()

        fun run() {
            val q = input.text.toString().trim()
            if (q.length < 2) {
                status.visibility = View.VISIBLE
                status.text = "Tape au moins 2 lettres puis OK."
                return
            }
            status.visibility = View.VISIBLE
            status.text = getString(R.string.loading)
            screenJob?.cancel()
            screenJob = lifecycleScope.launch {
                try {
                    val ch = repo.channels(q = q, limit = 24, offset = 0).items.map {
                        TileUi(it.id, it.name, it.country, it.logoUrl, "channel", it)
                    }
                    val vod = repo.vod(q = q, limit = 24, offset = 0).items.map {
                        TileUi(it.id, it.title, it.category, it.posterUrl, it.kind, it)
                    }
                    val ext = repo.externalTitles(q = q, limit = 12, offset = 0).items.map {
                        TileUi(it.id, it.title, it.year?.toString(), it.posterUrl, "external-title", it)
                    }
                    val all = ch + vod + ext
                    adapter.submitList(all)
                    status.visibility = if (all.isEmpty()) View.VISIBLE else View.GONE
                    if (all.isEmpty()) status.text = getString(R.string.empty_here)
                } catch (e: ApiException) {
                    if (e.isAccessDenied) showSettings(getString(R.string.need_access))
                    else {
                        status.visibility = View.VISIBLE
                        status.text = e.message
                    }
                } catch (_: Exception) {
                    status.visibility = View.VISIBLE
                    status.text = "Hors ligne ou serveur injoignable"
                }
            }
        }
        v.findViewById<Button>(R.id.search_go).setOnClickListener { run() }
        input.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_SEARCH) {
                run()
                true
            } else false
        }
        input.requestFocus()
    }

    // ------------------------------- Paramètres / Accès -------------------------------
    private fun showSettings(notice: String?) {
        val v = LayoutInflater.from(this).inflate(R.layout.screen_settings, container, false)
        container.addView(v)
        val state: TextView = v.findViewById(R.id.access_state)
        val code: EditText = v.findViewById(R.id.access_code)
        val submit: Button = v.findViewById(R.id.access_submit)
        val eco: Switch = v.findViewById(R.id.switch_eco)
        val tele: TextView = v.findViewById(R.id.telemetry_view)
        val vm = ViewModelProvider(this, factory)[AccessViewModel::class.java]
        eco.isChecked = store.dataSaver
        eco.setOnCheckedChangeListener { _, on -> store.dataSaver = on }
        v.findViewById<Button>(R.id.btn_legacy_open).setOnClickListener { openLegacy() }
        tele.text = snapshotTelemetry()
        Telemetry.markFirstScreen()

        screenJob = lifecycleScope.launch {
            vm.state.collect { s ->
                state.text = when {
                    s.checking -> getString(R.string.loading)
                    s.active -> "Accès actif" + (s.expiresAt?.let { " (jusqu'au $it)" } ?: "")
                    s.message != null -> s.message
                    notice != null -> notice
                    else -> getString(R.string.need_access)
                }
                submit.isEnabled = !s.busy
            }
        }
        submit.setOnClickListener { vm.redeem(code.text.toString()) }
        vm.check()
        if (notice != null) Toast.makeText(this, notice, Toast.LENGTH_LONG).show()
    }

    // ------------------------------- Détail + lecture -------------------------------
    private fun onTile(t: TileUi) {
        when (t.kind) {
            "channel" -> showChannelDetail(t)
            "MOVIE", "SERIES" -> showVodDetail(t)
            "youtube" -> PlayerActivity.openYoutube(this, t.id)
            "external-title" -> showExternalDetail(t)
            "external" -> {
                val p = t.payload as? tv.mbolo.tv.core.ExternalSource
                if (p == null || p.mode == "iframe") PlayerActivity.openExternal(this, null, null)
                else PlayerActivity.openExternal(this, p.host, p.playRef)
            }
            else -> PlayerActivity.openYoutube(this, t.id)
        }
    }

    /**
     * Détail externe : sources triées direct > autres. mode=direct → Media3,
     * mode=iframe → message explicite, JAMAIS de WebView de contournement.
     */
    private fun showExternalDetail(t: TileUi) {
        val dlg = AlertDialog.Builder(this)
            .setTitle(t.title)
            .setMessage(getString(R.string.loading))
            .setNegativeButton("Fermer", null)
            .show()
        lifecycleScope.launch {
            try {
                val (title, sources) = repo.externalSources(t.id)
                if (sources.isEmpty()) {
                    dlg.setMessage(getString(R.string.empty_here))
                    return@launch
                }
                val box = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
                sources.take(8).forEach { s ->
                    val b = Button(this@MainActivity)
                    b.text = "${s.host} — ${s.mode}"
                    b.isFocusable = true
                    b.setOnClickListener {
                        dlg.dismiss()
                        if (s.mode == "direct" && s.playRef != null) {
                            PlayerActivity.openExternal(this@MainActivity, s.host, s.playRef)
                        } else {
                            PlayerActivity.openExternal(this@MainActivity, null, null)
                        }
                    }
                    box.addView(b)
                }
                val scroll = android.widget.ScrollView(this@MainActivity)
                scroll.addView(box)
                dlg.setMessage(title.title)
                dlg.setView(scroll)
            } catch (e: ApiException) {
                if (e.isAccessDenied) {
                    dlg.dismiss()
                    showSettings(getString(R.string.need_access))
                } else dlg.setMessage(e.message)
            } catch (_: Exception) {
                dlg.setMessage("Hors ligne ou serveur injoignable")
            }
        }
    }

    private fun showChannelDetail(t: TileUi) {        val dlg = AlertDialog.Builder(this)
            .setTitle(t.title)
            .setMessage("${t.subtitle.orEmpty()}\n\n${getString(R.string.loading)}")
            .setPositiveButton(R.string.play) { d, _ ->
                d.dismiss()
                store.pushHistory("c:${t.id}")
                PlayerActivity.openChannel(this, t.id)
            }
            .setNeutralButton(R.string.fav_add, null)
            .setNegativeButton("Fermer", null)
            .show()
        // EPG à la demande (jamais au démarrage) + toggle favori.
        lifecycleScope.launch {
            try {
                val epg = repo.channelEpg(t.id).take(2)
                val txt = buildString {
                    append(t.subtitle.orEmpty())
                    if (epg.isNotEmpty()) {
                        append("\n\n▶ ")
                        append(epg[0].title)
                        if (epg.size > 1) {
                            append("\n⏭ ")
                            append(epg[1].title)
                        }
                    }
                }
                dlg.setMessage(txt)
            } catch (_: Exception) {
                dlg.setMessage(t.subtitle.orEmpty())
            }
        }
        dlg.getButton(AlertDialog.BUTTON_NEUTRAL)?.setOnClickListener {
            lifecycleScope.launch {
                try {
                    repo.setFavorite(t.id, true)
                    Toast.makeText(this@MainActivity, R.string.added_fav, Toast.LENGTH_SHORT).show()
                } catch (e: ApiException) {
                    if (e.isAccessDenied) showSettings(getString(R.string.need_access))
                } catch (_: Exception) {
                    Toast.makeText(this@MainActivity, "Hors ligne", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun showVodDetail(t: TileUi) {
        val dlg = AlertDialog.Builder(this)
            .setTitle(t.title)
            .setMessage(getString(R.string.loading))
            .setPositiveButton(R.string.play, null)
            .setNeutralButton(R.string.fav_add, null)
            .setNegativeButton("Fermer", null)
            .show()
        lifecycleScope.launch {
            try {
                val detail = repo.vodDetail(t.id)
                store.pushHistory("v:${t.id}")
                if (detail.kind == "SERIES") {
                    val seasons = repo.vodEpisodes(t.id)
                    val box = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
                    val scroll = android.widget.ScrollView(this@MainActivity)
                    scroll.addView(box)
                    seasons.take(3).forEach { s ->
                        s.episodes.take(10).forEach { e ->
                            val b = Button(this@MainActivity)
                            b.text = "S${s.number} E${e.num} — ${e.title ?: "Épisode ${e.num}"}"
                            b.isFocusable = true
                            b.setOnClickListener {
                                dlg.dismiss()
                                PlayerActivity.openVod(this@MainActivity, t.id, s.number, e.num)
                            }
                            box.addView(b)
                        }
                    }
                    dlg.setMessage(detail.description ?: t.subtitle.orEmpty())
                    dlg.setView(scroll)
                    dlg.getButton(AlertDialog.BUTTON_POSITIVE)?.setOnClickListener {
                        dlg.dismiss()
                        val first = seasons.firstOrNull()?.episodes?.firstOrNull()
                        PlayerActivity.openVod(this@MainActivity, t.id,
                            seasons.firstOrNull()?.number, first?.num)
                    }
                } else {
                    dlg.setMessage(detail.description ?: t.subtitle.orEmpty())
                    dlg.getButton(AlertDialog.BUTTON_POSITIVE)?.setOnClickListener {
                        dlg.dismiss()
                        PlayerActivity.openVod(this@MainActivity, t.id)
                    }
                }
            } catch (e: ApiException) {
                if (e.isAccessDenied) {
                    dlg.dismiss()
                    showSettings(getString(R.string.need_access))
                } else dlg.setMessage(e.message)
            } catch (_: Exception) {
                dlg.setMessage("Hors ligne ou serveur injoignable")
            }
        }
        dlg.getButton(AlertDialog.BUTTON_NEUTRAL)?.setOnClickListener {
            lifecycleScope.launch {
                try {
                    repo.setVodFavorite(t.id, true)
                    Toast.makeText(this@MainActivity, R.string.added_fav, Toast.LENGTH_SHORT).show()
                } catch (e: ApiException) {
                    if (e.isAccessDenied) showSettings(getString(R.string.need_access))
                } catch (_: Exception) {
                    Toast.makeText(this@MainActivity, "Hors ligne", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun snapshotTelemetry(): String {
        val (total, janky) = JankMetrics.counts()
        Telemetry.jank(total, janky)
        return Telemetry.snapshot()
    }

    private fun openLegacy() {
        try {
            startActivity(Intent(this, LegacyWebViewActivity::class.java))
        } catch (_: Exception) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (backStack.isEmpty()) super.onBackPressed()
        else show(backStack.removeLast())
    }

    override fun onDestroy() {
        screenJob?.cancel()
        try {
            monitor.stop()
        } catch (_: Exception) {
        }
        super.onDestroy()
    }
}
