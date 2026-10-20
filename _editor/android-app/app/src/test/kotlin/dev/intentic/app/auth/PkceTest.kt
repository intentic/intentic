package dev.intentic.app.auth

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PkceTest {
    @Test
    fun theChallengeIsRfc7636sS256() {
        // RFC 7636, appendix B.
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", Pkce.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
    }

    @Test
    fun aVerifierIsUnreservedCharactersWithinTheRfcsLength() {
        val verifier = Pkce.verifier()
        assertTrue(verifier.length in 43..128)
        assertTrue(verifier.matches(Regex("[A-Za-z0-9._~-]+")))
    }
}

class BrowserSignInTest {
    private val file: File = File(Files.createTempDirectory("browser-sign-in").toFile(), "attempt")
    private var now = 1_000_000L
    private val browser = BrowserSignIn(file, "https://app.example/", now = { now })

    private fun query(url: String, name: String) = Regex("[?&]$name=([^&]+)").find(url)!!.groupValues[1]

    @Test
    fun theLinkBackWithTheSameStateGetsTheVerifierWhoseChallengeTheUrlCarried() {
        val url = browser.begin()
        assertTrue(url.startsWith("https://app.example/desktop-auth?state="))
        val verifier = browser.finish(query(url, "state"))!!
        assertEquals(query(url, "challenge"), Pkce.challenge(verifier))
        assertNull("spent once", browser.finish(query(url, "state")))
    }

    @Test
    fun aLinkThisAppDidNotAskForLeavesTheLiveAttemptAlone() {
        val url = browser.begin()
        assertNull(browser.finish("somebody-else"))
        assertNull(browser.finish(null))
        assertTrue(browser.finish(query(url, "state")) != null)
    }

    @Test
    fun anAttemptTooOldIsRefused() {
        val url = browser.begin()
        now += 16 * 60_000L
        assertNull(browser.finish(query(url, "state")))
    }
}
