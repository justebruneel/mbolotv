package tv.mbolo.app.core

import org.junit.Assert.*
import org.junit.Test
import tv.mbolo.app.ui.PlayerViewModel

/**
 * Anti-rechargement d'écran, bornes de la télémétrie et enveloppe JSON.
 * 100 % JVM (horloge injectée, aucune dépendance Android).
 */
class CancellationAndFreshnessTest {

    @Test
    fun sameKeyIsFreshWithinTtl() {
        val f = ScreenFreshness(60_000)
        assertTrue(f.shouldReload("home", 1000))
        f.markLoaded("home", 1000)
        assertFalse(f.shouldReload("home", 1001))
    }

    @Test
    fun differentKeyForcesReload() {
        val f = ScreenFreshness(60_000)
        f.markLoaded("MOVIES|Action|", 1000)
        assertTrue(f.shouldReload("SERIES||", 1001))
    }

    @Test
    fun expiredTtlForcesReload() {
        val f = ScreenFreshness(60_000)
        f.markLoaded("home", 1000)
        assertTrue(f.shouldReload("home", 1000 + 60_001))
    }

    @Test
    fun apiLatenciesAreBounded() {
        repeat(150) { Telemetry.apiLatency(it.toLong()) }
        assertTrue(Telemetry.snapshot().contains("apiN=100"))
    }

    @Test
    fun jankCountersAppearBounded() {
        Telemetry.jank(10_000, 25)
        val s = Telemetry.snapshot()
        assertTrue(s.contains("frames=10000"))
        assertTrue(s.contains("jank=25"))
    }

    @Test
    fun snapshotHasNoSensitiveFieldNames() {
        Telemetry.networkKind = "wifi"
        val s = Telemetry.snapshot()
        assertFalse(s.contains("device"))
        assertFalse(s.contains("x-sig"))
        assertTrue(s.contains("net=wifi"))
    }

    @Test
    fun malformedArrayBodyThrowsApiException() {
        try {
            ApiClient.wrap("[{bad", "/x")
            fail("doit lever ApiException")
        } catch (e: ApiException) {
            assertEquals(-1, e.status)
        }
    }
}