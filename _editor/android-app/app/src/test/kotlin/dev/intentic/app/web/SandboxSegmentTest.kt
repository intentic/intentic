package dev.intentic.app.web

import dev.intentic.app.core.SandboxRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The same cases the shared sandbox-segment.test.ts pins for the web app, read here.
class SandboxSegmentTest {
    private val intentic = SandboxRow(id = "cmtu1eqyv0001dawma7zi4n3i", name = "Intentic", role = "owner", asleep = false)
    private val api = SandboxRow(id = "cmtu1f0aa0002dawmk82p1q7", name = "My API", role = "owner", asleep = false)
    private val listed = listOf(intentic, api)

    @Test
    fun nameAsWords() {
        assertEquals("my-api", sandboxSlug("My API"))
        assertEquals("cafe-unicode", sandboxSlug("  Café — Ünïcode!! "))
        assertEquals("the-quick-brown-fox-jumps-over-the-lazy", sandboxSlug("the quick brown fox jumps over the lazy dog and keeps on running"))
    }

    @Test
    fun readsTheKeyWhateverTheName() {
        assertEquals(intentic, sandboxOfSegment("intentic-zi4n3i", listed))
        assertEquals(intentic, sandboxOfSegment("old-name-zi4n3i", listed))
        assertEquals(intentic, sandboxOfSegment("zi4n3i", listed))
        assertEquals(api, sandboxOfSegment("my-api-82p1q7", listed))
    }

    @Test
    fun readsAWholeId() {
        assertEquals(intentic, sandboxOfSegment("cmtu1eqyv0001dawma7zi4n3i", listed))
        val odd = SandboxRow(id = "e2e-sandbox", name = "E2E", role = "owner", asleep = false)
        assertEquals(odd, sandboxOfSegment("e2e-sandbox", listOf(odd)))
    }

    @Test
    fun theNameDecidesBetweenTwoThatEndAlike() {
        val twin = SandboxRow(id = "cmtu9zzzz0009xxxxq7zi4n3i", name = "Twin", role = "owner", asleep = false)
        assertEquals(twin, sandboxOfSegment("twin-zi4n3i", listed + twin))
        assertNull(sandboxOfSegment("other-zi4n3i", listed + twin))
    }

    @Test
    fun namesNoneItCannotRead() {
        assertNull(sandboxOfSegment("intentic-n3i", listed))
        assertNull(sandboxOfSegment("intentic-abcdef", listed))
        assertNull(sandboxOfSegment("intentic-zi4n3i", emptyList()))
    }
}
