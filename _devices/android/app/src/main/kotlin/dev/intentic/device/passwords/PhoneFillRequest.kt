package dev.intentic.device.passwords

import org.json.JSONObject
import java.security.SecureRandom

/** Builds and signs the JSON body the keyring expects for one autofill (`KeyringPhoneFill` / `SignedKeyringPhoneFill`). */
object PhoneFillRequest {
    private const val TTL_MS = 2 * 60_000L
    private val random = SecureRandom()

    fun build(deviceId: String, origin: JSONObject, username: String?): JSONObject {
        val now = System.currentTimeMillis()
        val nonce = ByteArray(16).also { random.nextBytes(it) }
        return JSONObject()
            .put("v", 1)
            .put("device", deviceId)
            .put("origin", origin)
            .apply { if (!username.isNullOrBlank()) put("username", username) }
            .put("nonce", Base64Url.encode(nonce))
            .put("issuedAt", now)
            .put("expiresAt", now + TTL_MS)
    }

    fun signedPayload(fill: JSONObject): ByteArray = fill.toString().toByteArray(Charsets.UTF_8)

    fun wrapSigned(payloadBytes: ByteArray, signatureDer: ByteArray): JSONObject =
        JSONObject()
            .put("payload", Base64Url.encode(payloadBytes))
            .put("sig", Base64Url.encode(signatureDer))
}
