package tv.mbolo.tv.core

import org.junit.Assert.*
import org.junit.Test
import tv.mbolo.tv.ui.PlayerViewModel

/** Télémétrie bornée + clé de reprise VOD déterministe. */
class TelemetryAndResumeTest {

    @Test
    fun snapshotNeverContainsSensitiveData() {
        Telemetry.event("home-ok")
        Telemetry.apiLatency(120)
        val s = Telemetry.snapshot()
        assertTrue(s.contains("cold="))
        assertFalse(s.contains("x-sig"))
        assertFalse(s.contains("device"))
    }

    @Test
    fun progressKey_movieHasNoSuffix() {
        assertEquals("v1", PlayerViewModel.progressKey("v1", null, null))
    }

    @Test
    fun progressKey_episodeIsDeterministic() {
        assertEquals("s1|s1|e2", PlayerViewModel.progressKey("s1", 1, 2))
        assertEquals(PlayerViewModel.progressKey("s1", 1, 2), PlayerViewModel.progressKey("s1", 1, 2))
    }

    @Test
    fun pageSizeWithinSpec() {
        assertTrue(ApiConfig.PAGE_SIZE in 24..48)
        assertTrue(ApiConfig.TTL_PLAY_MS <= 60_000L)
    }
}
