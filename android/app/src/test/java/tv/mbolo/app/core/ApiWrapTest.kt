package tv.mbolo.app.core

import org.junit.Assert.*
import org.junit.Test

/** Enveloppe tableau-nu → {items} + erreurs HTTP typées. */
class ApiWrapTest {

    @Test
    fun bareArrayWrappedAsItems() {
        val o = ApiClient.wrap("""[{"id":"a"}]""", "/channels/x/epg")
        assertEquals(1, o.getJSONArray("items").length())
    }

    @Test
    fun objectPassThrough() {
        val o = ApiClient.wrap("""{"items":[],"total":0}""", "/channels")
        assertEquals(0, o.getInt("total"))
    }

    @Test
    fun blankBodyIsEmptyObject() {
        assertEquals(0, ApiClient.wrap("  ", "/x").length())
    }

    @Test(expected = ApiException::class)
    fun invalidBodyThrowsApiException() {
        ApiClient.wrap("not-json{{", "/x")
    }

    @Test
    fun statusPredicates() {
        assertTrue(ApiException(403, "/p", "m").isAccessDenied)
        assertTrue(ApiException(404, "/p", "m").isNotFound)
        assertTrue(ApiException(429, "/p", "m").isRateLimited)
        assertTrue(ApiException(503, "/p", "m").isServerError)
        assertTrue(ApiException(451, "/p", "m").isUnavailable)
    }
}
