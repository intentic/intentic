package dev.intentic.device.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The `direct` build's updater only reads, compares and verifies; these are the parts that run without a phone. */
class UpdateManifestTest {
    private val digest = "a".repeat(64)

    @Test
    fun `a manifest with a version, an https url and a sha256 is a release`() {
        assertEquals(
            Release("0.2.0", "https://github.com/intentic/intentic/releases/download/device-v0.2.0/intentic-device.apk", digest),
            UpdateManifest.parse("""{"version":"0.2.0","url":"https://github.com/intentic/intentic/releases/download/device-v0.2.0/intentic-device.apk","sha256":"$digest"}"""),
        )
        assertEquals(digest, UpdateManifest.parse("""{"version":"1","url":"https://x/y.apk","sha256":"${digest.uppercase()}"}""")!!.sha256)
    }

    @Test
    fun `anything else is not trusted`() {
        assertNull(UpdateManifest.parse("not json"))
        assertNull(UpdateManifest.parse("""{"version":"1","url":"http://x/y.apk","sha256":"$digest"}"""))
        assertNull(UpdateManifest.parse("""{"version":"1","url":"https://x/y.apk","sha256":"abc"}"""))
        assertNull(UpdateManifest.parse("""{"url":"https://x/y.apk","sha256":"$digest"}"""))
        assertNull(UpdateManifest.parse("""{"version":"","url":"https://x/y.apk","sha256":"$digest"}"""))
        assertNull(UpdateManifest.parse("""{"version":1,"url":"https://x/y.apk","sha256":"$digest"}"""))
    }

    @Test
    fun `versions compare by number, not by text`() {
        assertTrue(UpdateManifest.isNewer("0.10.0", "0.9.0"))
        assertTrue(UpdateManifest.isNewer("1.0.0", "0.9.9"))
        assertTrue(UpdateManifest.isNewer("1.0.1", "1.0"))
        assertFalse(UpdateManifest.isNewer("1.0.0", "1.0.0"))
        assertFalse(UpdateManifest.isNewer("1.0", "1.0.0"))
        assertFalse(UpdateManifest.isNewer("0.9.0", "0.10.0"))
        assertTrue(UpdateManifest.isNewer("v1.2.0", "1.1.9"))
    }

    @Test
    fun `a pre-release is earlier than its release`() {
        assertTrue(UpdateManifest.isNewer("1.0.0", "1.0.0-rc1"))
        assertFalse(UpdateManifest.isNewer("1.0.0-rc1", "1.0.0"))
        assertTrue(UpdateManifest.isNewer("1.0.0-rc2", "1.0.0-rc1"))
        assertTrue(UpdateManifest.isNewer("1.1.0-rc1", "1.0.0"))
    }
}
