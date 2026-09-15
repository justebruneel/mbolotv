package tv.mbolo.tv.core

import org.json.JSONArray
import org.json.JSONObject

/**
 * Modèles miroirs de `@mbolo/contracts` (lecture seule côté natif).
 * Parsing via `org.json` embarqué : zéro dépendance, APK minimal.
 */
data class Channel(
    val id: String,
    val name: String,
    val country: String?,
    val categoryId: String?,
    val logoUrl: String?,
    val healthStatus: String?,
    val nowTitle: String?,
)

data class Category(
    val id: String,
    val slug: String,
    val name: String,
    val parentId: String?,
    val channelCount: Int,
    val children: List<Category> = emptyList(),
)

data class CountryOption(val slug: String, val name: String, val count: Int)

data class VodItem(
    val id: String,
    val kind: String,
    val title: String,
    val posterUrl: String?,
    val backdropUrl: String?,
    val rating: Double?,
    val category: String?,
    val year: Int?,
    val description: String?,
)

data class VodCategory(val name: String, val label: String, val count: Int)

data class HomeRow(val title: String, val category: String?, val items: List<VodItem>)

data class PlayResponse(val url: String, val expiresAt: String?, val qualityCap: Int?)

data class AccessStatus(
    val active: Boolean,
    val expiresAt: String?,
    val kind: String?,
)

data class EpgProgramme(
    val id: String,
    val title: String,
    val description: String?,
    val startsAt: String,
    val endsAt: String,
    val imageUrl: String?,
)

data class Episode(val id: String, val num: Int, val title: String?, val ext: String?)
data class Season(val number: Int, val episodes: List<Episode>)

data class YoutubeVideo(
    val id: String,
    val title: String,
    val description: String?,
    val posterUrl: String?,
    val publishedAt: String?,
    val durationSec: Long?,
)

data class ExternalTitle(
    val id: String,
    val title: String,
    val year: Int?,
    val posterUrl: String?,
    val kind: String?,
)

data class ExternalSource(
    val id: String,
    val host: String,
    val mode: String,
    val playRef: String?,
)

data class Paged<T>(val items: List<T>, val total: Int, val hasMore: Boolean)

/** Tuile UI générique affichée par les RecyclerView (chaîne, VOD, YouTube…). */
data class TileUi(
    val id: String,
    val title: String,
    val subtitle: String?,
    val imageUrl: String?,
    /** channel | movie | series | youtube | external */
    val kind: String,
    val payload: Any? = null,
)

private fun JSONObject.str(key: String): String? =
    if (isNull(key)) null else optString(key, null)

private fun JSONObject.intOrNull(key: String): Int? =
    if (isNull(key)) null else optInt(key, Int.MIN_VALUE).takeIf { it != Int.MIN_VALUE }

object MboloJson {
    fun channel(o: JSONObject) = Channel(
        id = o.optString("id"),
        name = o.optString("name"),
        country = o.str("country"),
        categoryId = o.str("categoryId"),
        logoUrl = o.str("logoUrl"),
        healthStatus = o.str("healthStatus"),
        nowTitle = o.optJSONObject("nowPlaying")?.str("title"),
    )

    fun category(o: JSONObject): Category {
        val kids = mutableListOf<Category>()
        val arr = o.optJSONArray("children")
        if (arr != null) for (i in 0 until arr.length()) kids += category(arr.getJSONObject(i))
        return Category(
            id = o.optString("id"),
            slug = o.optString("slug"),
            name = o.optString("name"),
            parentId = o.str("parentId"),
            channelCount = o.optInt("channelCount", 0),
            children = kids,
        )
    }

    fun vod(o: JSONObject) = VodItem(
        id = o.optString("id"),
        kind = o.optString("kind", "MOVIE"),
        title = o.optString("title"),
        posterUrl = o.str("posterUrl"),
        backdropUrl = o.str("backdropUrl"),
        rating = if (o.isNull("rating")) null else o.optDouble("rating"),
        category = o.str("category"),
        year = o.intOrNull("year"),
        description = o.str("description"),
    )

    fun play(o: JSONObject) = PlayResponse(
        url = o.optString("url"),
        expiresAt = o.str("expiresAt"),
        qualityCap = o.intOrNull("qualityCap"),
    )

    fun access(o: JSONObject) = AccessStatus(
        active = o.optBoolean("active", false),
        expiresAt = o.str("expiresAt"),
        kind = o.str("kind"),
    )

    fun epg(o: JSONObject) = EpgProgramme(
        id = o.optString("id"),
        title = o.optString("title"),
        description = o.str("description"),
        startsAt = o.optString("startsAt"),
        endsAt = o.optString("endsAt"),
        imageUrl = o.str("imageUrl"),
    )

    fun youtube(o: JSONObject) = YoutubeVideo(
        id = o.optString("id"),
        title = o.optString("title"),
        description = o.str("description"),
        posterUrl = o.str("posterUrl"),
        publishedAt = o.str("publishedAt"),
        durationSec = if (o.isNull("duration")) null else o.optLong("duration", -1).takeIf { it >= 0 },
    )

    fun external(o: JSONObject) = ExternalTitle(
        id = o.optString("id"),
        title = o.optString("title"),
        year = o.intOrNull("year"),
        posterUrl = o.str("posterUrl"),
        kind = o.str("kind"),
    )

    fun objects(arr: JSONArray?): List<JSONObject> {
        if (arr == null) return emptyList()
        return (0 until arr.length()).mapNotNull { runCatching { arr.getJSONObject(it) }.getOrNull() }
    }
}
