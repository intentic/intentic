package dev.intentic.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.intentic.app.auth.PasskeyOrigin
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The installed app's certificate is readable, so the core gets an origin a passkey ceremony can be bound to. */
@RunWith(AndroidJUnit4::class)
class PasskeyOriginDeviceTest {
    @Test
    fun installedAppHasAnOrigin() {
        val origin = PasskeyOrigin.installed(ApplicationProvider.getApplicationContext()).orEmpty()
        // The prefix and 43 characters: a SHA-256 in base64url without padding.
        assertTrue(origin, Regex("android:apk-key-hash:[A-Za-z0-9_-]{43}").matches(origin))
    }
}
