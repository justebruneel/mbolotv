package tv.mbolo.app.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Parsing des contrats backend — aucune logique métier dupliquée, juste le mapping. */
class JsonParsingTest {

    @Test
    fun channel_parsesNowPlayingTitle() {
        val o = JSONObject("""{"id":"c1","name":"Canal","country":"Cameroun","categoryId":"k1",
            "logoUrl":"https://x/logo.png","healthStatus":"OK",
            "nowPlaying":{"title":"Match","startsAt":"2026-09-15T19:00:00Z"}}""")
        val c = MboloJson.channel(o)
        assertEquals("c1", c.id)
        assertEquals("Match", c.nowTitle)
        assertEquals("https://x/logo.png", c.logoUrl)
    }

    @Test
    fun channel_toleratesMissingOptionals() {
        val c = MboloJson.channel(JSONObject("""{"id":"c2","name":"N"}"""))
        assertNull(c.country)
        assertNull(c.nowTitle)
    }

    @Test
    fun vod_parsesFullAndLight() {
        val full = MboloJson.vod(JSONObject("""{"id":"v1","kind":"MOVIE","title":"T",
            "posterUrl":"https://x/p.jpg","rating":8.8,"category":"Action","year":2010,
            "description":"d","backdropUrl":"https://x/b.jpg"}"""))
        assertEquals(8.8, full.rating!!, 0.001)
        assertEquals(2010, full.year)
        val light = MboloJson.vod(JSONObject("""{"id":"v2","title":"L"}"""))
        assertNull(light.rating)
        assertEquals("MOVIE", light.kind)
    }

    @Test
    fun play_parsesSignedUrl() {
        val p = MboloJson.play(JSONObject(
            """{"url":"https://proxy/?url=a&x-exp=1&x-sig=s","expiresAt":"2026-09-16T00:00:00Z","qualityCap":480}"""))
        assertTrue(p.url.startsWith("https://proxy/"))
        assertEquals(480, p.qualityCap)
    }

    @Test
    fun access_parsesStatus() {
        val s = MboloJson.access(JSONObject("""{"active":true,"expiresAt":"2026-10-01","kind":"STANDARD"}"""))
        assertTrue(s.active)
        assertEquals("STANDARD", s.kind)
    }

    @Test
    fun youtube_parsesDurationOrNull() {
        val v = MboloJson.youtube(JSONObject("""{"id":"ABCDEFGHIJK","title":"T","duration":3600}"""))
        assertEquals(3600L, v.durationSec)
        val noDur = MboloJson.youtube(JSONObject("""{"id":"ABCDEFGHIJK","title":"T"}"""))
        assertNull(noDur.durationSec)
    }

    @Test
    fun objects_skipsMalformedEntries() {
        val arr = JSONArray("""[{"id":"a","name":"A"},"oops",42,{"id":"b","name":"B"}]""")
        val list = MboloJson.objects(arr).map(MboloJson::channel)
        assertEquals(listOf("a", "b"), list.map { it.id })
    }

    @Test
    fun objects_nullArrayIsEmpty() {
        assertTrue(MboloJson.objects(null).isEmpty())
    }
}
