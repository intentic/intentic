package dev.intentic.device.passwords

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneFillJsonTest {
    @Test
    fun `fill request uses contract field names`() {
        val origin = JSONObject().put("kind", "site").put("host", "github.com")
        val fill = PhoneFillRequest.build("phone-card-1", origin, "radarsu")
        assertEquals(1, fill.getInt("v"))
        assertEquals("phone-card-1", fill.getString("device"))
        assertEquals("github.com", fill.getJSONObject("origin").getString("host"))
        assertEquals("radarsu", fill.getString("username"))
        assertTrue(fill.getString("nonce").matches(Regex("^[A-Za-z0-9_-]{22}$")))
        assertTrue(fill.getLong("expiresAt") - fill.getLong("issuedAt") <= 120_000)
    }

    @Test
    fun `signed wrapper is base64url without padding`() {
        val payload = PhoneFillRequest.signedPayload(JSONObject().put("v", 1))
        val signed = PhoneFillRequest.wrapSigned(payload, byteArrayOf(1, 2, 3))
        assertTrue(signed.getString("payload").matches(Regex("^[A-Za-z0-9_-]+$")))
        assertTrue(signed.getString("sig").matches(Regex("^[A-Za-z0-9_-]+$")))
        assertEquals(false, signed.getString("payload").contains("="))
    }
}
