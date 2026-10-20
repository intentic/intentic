package dev.intentic.app.auth

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Base64

class PasskeyOriginTest {
    // A self-signed test certificate (DER); `openssl x509 -fingerprint -sha256` gives the FE:FE:CF:... below, which is
    // what assetlinks.json lists for an app signed with it.
    private val certificate = Base64.getDecoder().decode(
        "MIIBiDCCAS2gAwIBAgIUQWN8Dho6s0e71OQj0vrra4eTsLAwCgYIKoZIzj0EAwIwGDEWMBQGA1UEAwwNSW50ZW50aWMgdGVzdDAgFw0yNjEwMjAwMDQ2NTVaGA8y" +
            "MTI2MDkyNjAwNDY1NVowGDEWMBQGA1UEAwwNSW50ZW50aWMgdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABD5OAJ6pLwdK1XLMcs9dU7WzZ8r3Jsh2hJhY" +
            "g8DogKacFhCLari4ih8MbXoncqgM9Di5MoXlK6MLk0946Vo93pujUzBRMB0GA1UdDgQWBBTpoFBYlbhMh86Ey0ubLWZkyBHwqjAfBgNVHSMEGDAWgBTpoFBYlbhM" +
            "h86Ey0ubLWZkyBHwqjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQCYiPZ3g5RmBHc2XMW8kooWn3c5oorWm9szUDWlmMvw+gIhANxC0FCKCGXI" +
            "rgiXjdtnKBUpbSODXwYOgjtZ2SSW8xv8",
    )
    private val fingerprint = "FE:FE:CF:07:F7:16:B3:17:58:04:51:DC:A9:03:9B:6E:8D:81:43:50:CD:44:50:29:5A:AF:80:38:60:41:86:E0"

    @Test
    fun originIsTheUnpaddedUrlSafeHashOfTheCertificate() {
        assertEquals("android:apk-key-hash:_v7PB_cWsxdYBFHcqQObbo2BQ1DNRFApWq-AOGBBhuA", PasskeyOrigin.of(certificate))
    }

    @Test
    fun originCarriesTheSameHashAsTheAssetLinksFingerprint() {
        val hash = fingerprint.split(':').map { it.toInt(16).toByte() }.toByteArray()
        val origin = PasskeyOrigin.of(certificate)
        assertEquals(hash.toList(), Base64.getUrlDecoder().decode(origin.removePrefix("android:apk-key-hash:")).toList())
    }
}
