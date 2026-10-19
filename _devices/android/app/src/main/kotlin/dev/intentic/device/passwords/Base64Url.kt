package dev.intentic.device.passwords

import java.util.Base64

/** Base64url without padding, as the keyring wire uses for keys and sealed boxes. */
object Base64Url {
    private val encoder = Base64.getUrlEncoder().withoutPadding()
    private val decoder = Base64.getUrlDecoder()

    fun encode(bytes: ByteArray): String = encoder.encodeToString(bytes)

    fun decode(text: String): ByteArray = decoder.decode(text)
}
