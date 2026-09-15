package tv.mbolo.app.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Repository natif — miroir des hooks `apps/web/src/shared/api/queries.ts`.
 * Aucune logique métier dupliquée : pagination, TTL et contrats du backend
 * existant respectés. Toute méthode est `suspend` (Dispatchers.IO via ApiClient).
 */
class MboloRepository(val api: ApiClient) {

    // ---- Cache mémoire TTL (catalogue peu volatil uniquement) ----
    // Note : l'annulation de coroutine n'est JAMAIS avalée ici : toute
    // CancellationException est re-lancée pour que quitter un écran annule
    // réellement le travail (pas de requêtes fantômes sur Wi-Fi lent).
    private data class Entry(val at: Long, val value: Any)
    private val mem = LinkedHashMap<String, Entry>()

    @Synchronized
    private fun <T : Any> peek(key: String, ttl: Long): T? {
        @Suppress("UNCHECKED_CAST")
        val hit = mem[key] ?: return null
        if (System.currentTimeMillis() - hit.at >= ttl) {
            mem.remove(key)
            return null
        }
        @Suppress("UNCHECKED_CAST")
        return hit.value as T
    }

    @Synchronized
    private fun put(key: String, value: Any) {
        if (mem.size > 60) mem.remove(mem.keys.first())
        mem[key] = Entry(System.currentTimeMillis(), value)
    }

    private suspend fun <T : Any> withMem(key: String, ttl: Long, load: suspend () -> T): T {
        peek<T>(key, ttl)?.let { return it }
        val v = load() // CancellationException éventuelle : propagée telle quelle.
        put(key, v)
        return v
    }

    // ---- Auth / DeviceGrant (flux existant, inchangé côté serveur) ----
    suspend fun accessStatus(): AccessStatus =
        MboloJson.access(api.get("/access/status"))

    suspend fun redeem(code: String): AccessStatus =
        MboloJson.access(api.post("/access/redeem", JSONObject().put("code", code.trim().uppercase())))

    // ---- Chaînes live ----
    suspend fun channels(
        category: String? = null, country: String? = null, q: String? = null,
        limit: Int = ApiConfig.PAGE_SIZE, offset: Int = 0,
    ): Paged<Channel> {
        val o = api.get("/channels", mapOf(
            "category" to category, "country" to country, "q" to q,
            "limit" to limit.toString(), "offset" to offset.toString(),
        ))
        val items = MboloJson.objects(o.optJSONArray("items")).map(MboloJson::channel)
        return Paged(items, o.optInt("total", items.size), o.optBoolean("hasMore", false))
    }

    suspend fun countries(): List<CountryOption> = withMem("countries", ApiConfig.TTL_COUNTRIES_MS) {
        val o = api.get("/channels/countries")
        val arr = o.optJSONArray("items") ?: o.optJSONArray("countries") ?: org.json.JSONArray()
        MboloJson.objects(arr).map {
            CountryOption(it.optString("slug"), it.optString("name"), it.optInt("count", 0))
        }
    }

    suspend fun channel(id: String): Channel = MboloJson.channel(api.get("/channels/$id"))

    suspend fun channelEpg(id: String): List<EpgProgramme> {
        val o = api.get("/channels/$id/epg")
        val arr = o.optJSONArray("items") ?: o.optJSONArray("programmes") ?: o.optJSONArray("epg")
            ?: org.json.JSONArray()
        // Le Worker renvoie parfois un tableau nu enveloppé : si l'objet racine
        // n'a pas de clé connue mais que des clés programme existent, fallback vide.
        return MboloJson.objects(arr).map(MboloJson::epg)
    }

    suspend fun categories(): List<Category> = withMem("categories", ApiConfig.TTL_CATEGORIES_MS) {
        val o = api.get("/categories")
        val arr = o.optJSONArray("items") ?: o.optJSONArray("categories") ?: org.json.JSONArray()
        MboloJson.objects(arr).map(MboloJson::category)
    }

    suspend fun geoFeatured(): Pair<String?, List<Channel>> {
        val o = api.get("/geo/featured")
        val arr = o.optJSONArray("channels") ?: org.json.JSONArray()
        return Pair(o.optString("country", null), MboloJson.objects(arr).map(MboloJson::channel))
    }

    // ---- Lecture live : GET /channels/:id/play (URL signée utilisée telle quelle) ----
    suspend fun channelPlay(id: String, eco: Boolean): PlayResponse =
        MboloJson.play(api.get("/channels/$id/play", if (eco) mapOf("eco" to "1") else emptyMap(), noRetry = true))

    // ---- EPG ----
    suspend fun epgFeatured(limit: Int = 5): List<EpgProgramme> {
        val o = api.get("/epg/featured", mapOf("limit" to limit.toString()))
        val arr = o.optJSONArray("items") ?: org.json.JSONArray()
        return MboloJson.objects(arr).mapNotNull {
            val p = it.optJSONObject("programme") ?: it
            runCatching { MboloJson.epg(p) }.getOrNull()
        }
    }

    // ---- VOD Xtream ----
    suspend fun vod(kind: String? = null, category: String? = null, q: String? = null,
                    limit: Int = ApiConfig.PAGE_SIZE, offset: Int = 0): Paged<VodItem> {
        val o = api.get("/vod", mapOf(
            "kind" to kind, "category" to category, "q" to q,
            "limit" to limit.toString(), "offset" to offset.toString(),
        ))
        val items = MboloJson.objects(o.optJSONArray("items")).map(MboloJson::vod)
        return Paged(items, o.optInt("total", items.size), o.optBoolean("hasMore", false))
    }

    suspend fun vodCategories(kind: String? = null): List<VodCategory> {
        val o = api.get("/vod/categories", mapOf("kind" to kind))
        val arr = o.optJSONArray("items") ?: o.optJSONArray("categories") ?: org.json.JSONArray()
        return MboloJson.objects(arr).map {
            VodCategory(it.optString("name"), it.optString("label", it.optString("name")), it.optInt("count", 0))
        }
    }

    /** Accueil Netflix en 1 aller-retour — idéal TV faible. */
    suspend fun vodRows(kind: String? = null): List<HomeRow> = withMem("vodrows:${kind ?: "all"}", ApiConfig.TTL_HOME_ROWS_MS) {
        val o = api.get("/vod/rows", mapOf("kind" to kind))
        MboloJson.objects(o.optJSONArray("rows")).map { r ->
            HomeRow(
                title = r.optString("name"),
                category = r.optString("category", null),
                items = MboloJson.objects(r.optJSONArray("items")).map(MboloJson::vod),
            )
        }
    }

    suspend fun vodDetail(id: String): VodItem = MboloJson.vod(api.get("/vod/$id"))

    suspend fun vodEpisodes(id: String): List<Season> {
        val o = api.get("/vod/$id/episodes")
        val arr = o.optJSONArray("seasons") ?: org.json.JSONArray()
        return MboloJson.objects(arr).map { s ->
            Season(
                number = s.optInt("number", 1),
                episodes = MboloJson.objects(s.optJSONArray("episodes")).map { e ->
                    Episode(e.optString("id"), e.optInt("num", 0), e.optString("title", null), e.optString("containerExt", "mp4"))
                },
            )
        }
    }

    suspend fun vodPlay(id: String, season: Int? = null, episode: Int? = null): PlayResponse {
        val p = mutableMapOf<String, String?>()
        if (season != null) p["s"] = season.toString()
        if (episode != null) p["e"] = episode.toString()
        return MboloJson.play(api.get("/vod/$id/play", p, noRetry = true))
    }

    // ---- VOD externe ----
    suspend fun externalTitles(q: String? = null, kind: String? = null,
                               limit: Int = ApiConfig.PAGE_SIZE, offset: Int = 0): Paged<ExternalTitle> {
        val o = api.get("/x/titles", mapOf(
            "q" to q, "kind" to kind,
            "limit" to limit.toString(), "offset" to offset.toString(),
        ))
        val items = MboloJson.objects(o.optJSONArray("items")).map(MboloJson::external)
        return Paged(items, o.optInt("total", items.size), o.optBoolean("hasMore", false))
    }

    suspend fun externalSources(id: String): Pair<ExternalTitle, List<ExternalSource>> {
        val o = api.get("/x/titles/$id")
        val title = MboloJson.external(o)
        val srcs = MboloJson.objects(o.optJSONArray("sources")).map { s ->
            ExternalSource(s.optString("id"), s.optString("host"), s.optString("mode", "iframe"), s.optString("playRef", null))
        }
        return Pair(title, srcs)
    }

    /** Résolution au clic uniquement (liens à expiry courte), jamais en masse. */
    suspend fun externalPlay(host: String, ref: String): List<String> {
        val o = api.get("/x/play", mapOf("host" to host, "id" to ref), noRetry = true)
        val arr = o.optJSONArray("urls") ?: org.json.JSONArray()
        return (0 until arr.length()).mapNotNull { arr.optString(it, null) }
    }

    // ---- YouTube (catalogue + InnerTube backend, MP4 progressif) ----
    suspend fun youtubeChannels(): List<String> {
        val o = api.get("/vod/youtube/channels")
        val arr = o.optJSONArray("channelIds") ?: o.optJSONArray("items") ?: org.json.JSONArray()
        return (0 until arr.length()).mapNotNull { arr.optString(it, null) }
    }
    suspend fun youtubeList(channel: String, pageToken: String? = null,
                            limit: Int = 25, q: String? = null): Pair<List<YoutubeVideo>, String?> {
        val o = api.get("/vod/youtube", mapOf(
            "channel" to channel, "pageToken" to pageToken,
            "limit" to limit.toString(), "q" to q,
        ))
        val items = MboloJson.objects(o.optJSONArray("items")).map(MboloJson::youtube)
        return Pair(items, o.optString("nextPageToken", null))
    }

    suspend fun youtubeVideo(id: String): YoutubeVideo =
        MboloJson.youtube(api.get("/vod/youtube/video", mapOf("id" to id)))

    suspend fun youtubePlay(id: String): List<String> {
        val o = api.get("/yt/play", mapOf("id" to id), noRetry = true)
        val arr = o.optJSONArray("urls") ?: org.json.JSONArray()
        return (0 until arr.length()).mapNotNull { arr.optString(it, null) }
    }

    // ---- Favoris (serveur) + cache local d'affichage immédiat ----
    suspend fun favorites(): List<Channel> {
        val o = api.get("/favorites")
        return MboloJson.objects(o.optJSONArray("items")).map(MboloJson::channel)
    }

    suspend fun setFavorite(id: String, on: Boolean) {
        if (on) api.put("/favorites/$id") else api.delete("/favorites/$id")
    }

    suspend fun vodFavorites(): List<VodItem> {
        val o = api.get("/vod/favorites")
        return MboloJson.objects(o.optJSONArray("items")).map(MboloJson::vod)
    }

    suspend fun setVodFavorite(id: String, on: Boolean) {
        if (on) api.put("/vod/$id/favorite") else api.delete("/vod/$id/favorite")
    }

    // ---- Activité (compteurs + heartbeat éco, 60s comme le web) ----
    suspend fun activityCounts(): Int =
        runCatching { api.get("/activity/counts").optInt("global", 0) }.getOrDefault(0)

    suspend fun heartbeat(channelId: String?) {
        runCatching {
            withContext(Dispatchers.IO) {
                api.post("/activity/heartbeat", JSONObject().put("channelId", channelId))
            }
        }
    }

    // ---- Recherche programmes ----
    suspend fun searchProgrammes(q: String, limit: Int = 20): List<EpgProgramme> {
        val o = api.get("/programmes/search", mapOf("q" to q, "limit" to limit.toString()))
        return MboloJson.objects(o.optJSONArray("items")).mapNotNull {
            runCatching { MboloJson.epg(it) }.getOrNull()
        }
    }
}
