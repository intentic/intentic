package dev.intentic.app.secret

import java.security.GeneralSecurityException
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-256-GCM over a few bytes, with a fresh IV per wrap, written `base64(iv).base64(ciphertext+tag)` as
 * `_devices/android`'s SecretBox writes its token. The key comes from [key]: the Keystore's in the app, a plain
 * in-memory one in a test.
 */
class KeyWrap(private val key: () -> SecretKey) {
    fun wrap(plain: ByteArray): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(plain)
        return "${BASE64.encodeToString(cipher.iv)}.${BASE64.encodeToString(encrypted)}"
    }

    /** Null when [wrapped] was not written by this key, was altered, or the key is gone. */
    fun unwrap(wrapped: String): ByteArray? {
        val parts = wrapped.trim().split('.')
        if (parts.size != 2) {
            return null
        }
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, Base64.getDecoder().decode(parts[0])))
            cipher.doFinal(Base64.getDecoder().decode(parts[1]))
        } catch (ignored: GeneralSecurityException) {
            null
        } catch (ignored: IllegalArgumentException) {
            null
        }
    }

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
        val BASE64: Base64.Encoder = Base64.getEncoder()
    }
}
