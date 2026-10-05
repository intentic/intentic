package dev.intentic.device.store

import java.security.GeneralSecurityException
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Seals a short secret for storage and opens it again. */
interface SecretBox {
    fun seal(plain: String): String

    /** Null when the text was not sealed by this box, was altered, or its key is gone. */
    fun open(sealed: String): String?
}

/**
 * AES-256-GCM with a fresh random IV per seal, stored as `base64(iv).base64(ciphertext+tag)`. The key comes from
 * [key]: the Android Keystore in the app (KeystoreKey), a plain in-memory key in a test. The key never leaves the
 * Keystore on a phone, so the stored token cannot be opened off the device or by another app.
 */
class AesGcmBox(private val key: () -> SecretKey) : SecretBox {
    override fun seal(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return "${Base64.getEncoder().encodeToString(cipher.iv)}.${Base64.getEncoder().encodeToString(encrypted)}"
    }

    override fun open(sealed: String): String? {
        val parts = sealed.split('.')
        if (parts.size != 2) {
            return null
        }
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, Base64.getDecoder().decode(parts[0])))
            String(cipher.doFinal(Base64.getDecoder().decode(parts[1])), Charsets.UTF_8)
        } catch (ignored: GeneralSecurityException) {
            null
        } catch (ignored: IllegalArgumentException) {
            null
        }
    }

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
    }
}
