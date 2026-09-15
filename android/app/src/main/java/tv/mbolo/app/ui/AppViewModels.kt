package tv.mbolo.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import tv.mbolo.app.core.ApiException
import tv.mbolo.app.core.Channel
import tv.mbolo.app.core.DeviceStore
import tv.mbolo.app.core.HomeRow
import tv.mbolo.app.core.MboloRepository
import tv.mbolo.app.core.ScreenFreshness
import tv.mbolo.app.core.TileUi
import tv.mbolo.app.core.VodItem
import tv.mbolo.app.core.YoutubeVideo

/** fabrique manuelle (pas de Hilt en v1 : APK minimal). */
class VmFactory(val repo: MboloRepository, val store: DeviceStore) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        return when {
            modelClass.isAssignableFrom(HomeViewModel::class.java) -> HomeViewModel(repo) as T
            modelClass.isAssignableFrom(BrowseViewModel::class.java) -> BrowseViewModel(repo) as T
            modelClass.isAssignableFrom(PlayerViewModel::class.java) -> PlayerViewModel(repo, store) as T
            modelClass.isAssignableFrom(AccessViewModel::class.java) -> AccessViewModel(repo) as T
            else -> throw IllegalArgumentException(modelClass.name)
        }
    }
}

fun Channel.toTile() = TileUi(id, name, country, logoUrl, "channel", this)
fun VodItem.toTile() = TileUi(id, title, category ?: year?.toString(), posterUrl, kind, this)
fun YoutubeVideo.toTile() = TileUi(id, title, publishedAt?.substringBefore("T"), posterUrl, "youtube", this)

data class HomeState(
    val loading: Boolean = true,
    val rows: List<HomeRowUi> = emptyList(),
    /** true si 403 : l'app doit afficher l'écran d'accès. */
    val accessRequired: Boolean = false,
    val error: String? = null,
)

/** Accueil : 3 appels en parallèle (featured + films + séries), jamais tout le catalogue. */
class HomeViewModel(private val repo: MboloRepository) : ViewModel() {
    private val _state = MutableStateFlow(HomeState())
    val state: StateFlow<HomeState> = _state
    private var job: Job? = null
    private val fresh = ScreenFreshness()

    /** Annule le chargement en cours (sortie d'écran) : aucun callback fantôme. */
    fun cancel() {
        job?.cancel()
    }

    fun load(force: Boolean = false) {
        if (!force && _state.value.rows.isNotEmpty() && !fresh.shouldReload("home")) return
        job?.cancel()
        job = viewModelScope.launch {
            _state.value = HomeState(loading = true)
            try {
                // Parallèle : sur Wi-Fi lent, la latence totale = la plus lente,
                // pas la somme. Émission progressive dès la 1re réponse (P2).
                val featured = async { repo.geoFeatured() }
                val movies = async { repo.vodRows("MOVIE") }
                val series = async { repo.vodRows("SERIES") }
                val (_, feat) = featured.await()
                if (feat.isNotEmpty()) {
                    _state.value = HomeState(
                        loading = true,
                        rows = listOf(HomeRowUi("À la une", feat.map { it.toTile() })),
                    )
                }
                val m = movies.await()
                val s = series.await()
                val rows = buildList {
                    if (feat.isNotEmpty()) add(HomeRowUi("À la une", feat.map { it.toTile() }))
                    m.take(4).forEach { r ->
                        if (r.items.isNotEmpty()) add(HomeRowUi(r.title.ifBlank { "Films" }, r.items.map { it.toTile() }))
                    }
                    s.take(4).forEach { r ->
                        if (r.items.isNotEmpty()) add(HomeRowUi(r.title.ifBlank { "Séries" }, r.items.map { it.toTile() }))
                    }
                }
                fresh.markLoaded("home")
                _state.value = HomeState(loading = false, rows = rows)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (e.isAccessDenied) _state.value = HomeState(loading = false, accessRequired = true)
                else _state.value = HomeState(loading = false, error = e.message ?: "Erreur réseau")
            } catch (_: Exception) {
                _state.value = HomeState(loading = false, error = "Hors ligne ou serveur injoignable")
            }
        }
    }
}

enum class BrowseMode { CHANNELS, MOVIES, SERIES, FAVORITES, EXTERNAL, YOUTUBE }

data class BrowseState(
    val loading: Boolean = true,
    val items: List<TileUi> = emptyList(),
    val loadingMore: Boolean = false,
    val end: Boolean = false,
    val accessRequired: Boolean = false,
    val error: String? = null,
)

/** Grille paginée générique (24/page) : jamais de centaines d'éléments. */
class BrowseViewModel(private val repo: MboloRepository) : ViewModel() {
    private val _state = MutableStateFlow(BrowseState())
    val state: StateFlow<BrowseState> = _state
    private var job: Job? = null
    private var offset = 0
    private var mode = BrowseMode.CHANNELS
    private var category: String? = null
    private var query: String? = null
    private var ytChannel: String? = null
    private var ytToken: String? = null
    private var ytEnd = false
    private val fresh = ScreenFreshness()

    /** Annule le chargement en cours (sortie d'écran). */
    fun cancel() {
        job?.cancel()
    }

    fun load(mode: BrowseMode, category: String? = null, q: String? = null, force: Boolean = false) {
        val key = "$mode|${category.orEmpty()}|${q.orEmpty()}"
        if (!force && _state.value.items.isNotEmpty() && !fresh.shouldReload(key)) return
        this.mode = mode
        this.category = category
        this.query = q
        offset = 0
        ytChannel = null
        ytToken = null
        ytEnd = false
        job?.cancel()
        job = viewModelScope.launch {
            _state.value = BrowseState(loading = true)
            try {
                val page = firstPage()
                val end = mode == BrowseMode.YOUTUBE && ytEnd || page.size < 24
                fresh.markLoaded(key)
                _state.value = BrowseState(loading = false, items = page, end = end)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (e.isAccessDenied) _state.value = BrowseState(loading = false, accessRequired = true)
                else _state.value = BrowseState(loading = false, error = e.message ?: "Erreur réseau")
            } catch (_: Exception) {
                _state.value = BrowseState(loading = false, error = "Hors ligne ou serveur injoignable")
            }
        }
    }

    fun loadMore() {
        val s = _state.value
        if (s.loading || s.loadingMore || s.end) return
        job?.cancel()
        job = viewModelScope.launch {
            _state.value = s.copy(loadingMore = true)
            try {
                if (mode == BrowseMode.YOUTUBE) {
                    val page = fetchYoutube()
                    _state.value = s.copy(loadingMore = false, items = s.items + page, end = ytEnd)
                } else {
                    val page = fetch(offset)
                    offset += page.size
                    _state.value = s.copy(loadingMore = false, items = s.items + page, end = page.size < 24)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _state.value = s.copy(loadingMore = false)
            }
        }
    }

    private suspend fun firstPage(): List<TileUi> {
        return if (mode == BrowseMode.YOUTUBE) fetchYoutube() else fetch(0).also { offset = it.size }
    }

    private suspend fun fetch(off: Int): List<TileUi> = when (mode) {
        BrowseMode.CHANNELS -> repo.channels(category = category, q = query, limit = 24, offset = off).items.map { it.toTile() }
        BrowseMode.MOVIES -> repo.vod(kind = "MOVIE", category = category, q = query, limit = 24, offset = off).items.map { it.toTile() }
        BrowseMode.SERIES -> repo.vod(kind = "SERIES", category = category, q = query, limit = 24, offset = off).items.map { it.toTile() }
        BrowseMode.FAVORITES -> if (off == 0) repo.favorites().map { it.toTile() } else emptyList()
        BrowseMode.EXTERNAL -> repo.externalTitles(q = query, limit = 24, offset = off).items.map {
            TileUi(it.id, it.title, it.year?.toString(), it.posterUrl, "external-title", it)
        }
        BrowseMode.YOUTUBE -> fetchYoutube()
    }

    /** Pagination YouTube par pageToken (pas d'offset) + allowlist serveur. */
    private suspend fun fetchYoutube(): List<TileUi> {
        val ch = ytChannel ?: repo.youtubeChannels().firstOrNull()?.also { ytChannel = it }
            ?: return emptyList()
        val (items, next) = repo.youtubeList(ch, pageToken = ytToken, limit = 25, q = query)
        ytToken = next?.takeIf { items.isNotEmpty() }
        ytEnd = ytToken == null
        return items.map { it.toTile() }
    }
}

data class PlayState(
    val loading: Boolean = true,
    val url: String? = null,
    val resumeMs: Long = 0,
    val accessRequired: Boolean = false,
    /** Message non technique + `externalOnly` pour mode=iframe. */
    val error: String? = null,
    val externalOnly: Boolean = false,
)

/**
 * Résolution de lecture : URLs signées utilisées telles quelles.
 * Retry : 1 refresh explicite (pas de boucle). 403 → écran d'accès.
 */
class PlayerViewModel(private val repo: MboloRepository, private val store: DeviceStore) : ViewModel() {
    private val _state = MutableStateFlow(PlayState())
    val state: StateFlow<PlayState> = _state
    private var job: Job? = null

    fun playChannel(id: String) = resolve {
        val play = repo.channelPlay(id, eco = store.dataSaver)
        Triple(play.url, 0L, false)
    }

    fun playVod(id: String, season: Int?, episode: Int?) = resolve {
        val play = repo.vodPlay(id, season, episode)
        val resume = store.vodProgress(episodeKey(id, season, episode))
        Triple(play.url, resume, false)
    }

    fun playYoutube(id: String) = resolve {
        val urls = repo.youtubePlay(id)
        Triple(urls.firstOrNull() ?: throw ApiException(451, "/yt/play", "Flux indisponible"), 0L, false)
    }

    fun playExternal(host: String, ref: String) = resolve {
        val urls = repo.externalPlay(host, ref)
        Triple(urls.firstOrNull() ?: throw ApiException(502, "/x/play", "Extraction impossible"), 0L, false)
    }

    fun externalUnsupported() {
        _state.value = PlayState(
            loading = false,
            externalOnly = true,
            error = "Cette source nécessite un lecteur externe et n'est pas disponible dans l'application native.",
        )
    }

    private fun resolve(block: suspend () -> Triple<String, Long, Boolean>) {
        job?.cancel()
        job = viewModelScope.launch {
            _state.value = PlayState(loading = true)
            try {
                val (url, resume, _) = block()
                _state.value = PlayState(loading = false, url = url, resumeMs = resume)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                _state.value = when {
                    e.isAccessDenied -> PlayState(loading = false, accessRequired = true)
                    e.isUnavailable -> PlayState(loading = false, error = "Flux indisponible sur cet appareil (${e.status})")
                    e.isNotFound -> PlayState(loading = false, error = "Contenu introuvable ou expiré")
                    else -> PlayState(loading = false, error = "Lecture impossible — réessaie (erreur ${e.status})")
                }
            } catch (_: Exception) {
                _state.value = PlayState(loading = false, error = "Hors ligne ou serveur injoignable")
            }
        }
    }

    private fun episodeKey(id: String, s: Int?, e: Int?) = progressKey(id, s, e)

    companion object {
        fun progressKey(id: String, s: Int?, e: Int?) =
            if (s != null || e != null) "$id|s$s|e$e" else id
    }
}

data class AccessState(
    val checking: Boolean = true,
    val active: Boolean = false,
    val expiresAt: String? = null,
    val message: String? = null,
    val busy: Boolean = false,
)

class AccessViewModel(private val repo: MboloRepository) : ViewModel() {
    private val _state = MutableStateFlow(AccessState())
    val state: StateFlow<AccessState> = _state
    private var job: Job? = null

    fun check() {
        job?.cancel()
        job = viewModelScope.launch {
            _state.value = AccessState(checking = true)
            try {
                val s = repo.accessStatus()
                _state.value = AccessState(checking = false, active = s.active, expiresAt = s.expiresAt)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _state.value = AccessState(checking = false, message = "Vérification impossible hors ligne")
            }
        }
    }

    fun redeem(code: String) {
        job?.cancel()
        job = viewModelScope.launch {
            _state.value = _state.value.copy(busy = true, message = null)
            try {
                val s = repo.redeem(code)
                _state.value = AccessState(checking = false, active = s.active, expiresAt = s.expiresAt,
                    message = if (s.active) "Accès activé" else "Code refusé")
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                _state.value = _state.value.copy(busy = false, message = when (e.status) {
                    403 -> "Code invalide ou désactivé"
                    409 -> "Code déjà lié à un autre appareil"
                    429 -> "Trop de tentatives — réessaie dans 15 min"
                    else -> "Échec d'activation (${e.status})"
                })
            } catch (_: Exception) {
                _state.value = _state.value.copy(busy = false, message = "Hors ligne — réessaie")
            }
        }
    }
}
