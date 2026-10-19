package dev.intentic.device.passwords

import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.json.JSONObject
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec

/**
 * X25519 → HKDF-SHA256 → AES-256-GCM, matching `_shared/sandbox-contract/src/policy/keyring-seal.ts`. BouncyCastle
 * provides X25519 on API 26; the platform's `KeyAgreement("XDH")` only arrives at API 31, below this app's minSdk.
 */
object Seal {
    private const val SEAL_INFO = "intentic-keyring/seal/v1"
    private const val TAG_BITS = 128

    data class Box(val v: Int, val epk: String, val iv: String, val tag: String, val data: String) {
        fun toJson(): JSONObject = JSONObject().put("v", v).put("epk", epk).put("iv", iv).put("tag", tag).put("data", data)
    }

    data class KeyPair(val publicKey: String, val privateKey: String)

    fun newKeyPair(): KeyPair {
        // BouncyCastle draws and clamps the scalar itself, as Node's generateKeyPairSync("x25519") does.
        val private = X25519PrivateKeyParameters(SecureRandom())
        return KeyPair(Base64Url.encode(private.generatePublicKey().encoded), Base64Url.encode(private.encoded))
    }

    fun sealRandom(recipientPublic: String, plaintext: String, purposeAad: ByteArray): Box {
        val ephemeral = newKeyPair()
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        return seal(recipientPublic, plaintext, purposeAad, ephemeral, iv)
    }

    fun seal(recipientPublic: String, plaintext: String, purposeAad: ByteArray, ephemeral: KeyPair, iv: ByteArray): Box {
        val shared = x25519Shared(Base64Url.decode(ephemeral.privateKey), Base64Url.decode(recipientPublic))
        val key = boxKey(shared, ephemeral.publicKey, recipientPublic)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, javax.crypto.spec.SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
        cipher.updateAAD(purposeAad)
        val encrypted = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val tagLen = 16
        val data = encrypted.copyOf(encrypted.size - tagLen)
        val tag = encrypted.copyOfRange(encrypted.size - tagLen, encrypted.size)
        return Box(1, ephemeral.publicKey, Base64Url.encode(iv), Base64Url.encode(tag), Base64Url.encode(data))
    }

    fun unseal(pair: KeyPair, box: Box, purposeAad: ByteArray): String {
        val shared = x25519Shared(Base64Url.decode(pair.privateKey), Base64Url.decode(box.epk))
        val key = boxKey(shared, box.epk, pair.publicKey)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            javax.crypto.spec.SecretKeySpec(key, "AES"),
            GCMParameterSpec(TAG_BITS, Base64Url.decode(box.iv)),
        )
        cipher.updateAAD(purposeAad)
        val combined = Base64Url.decode(box.data) + Base64Url.decode(box.tag)
        return String(cipher.doFinal(combined), Charsets.UTF_8)
    }

    fun captureAad(via: String, at: Long): ByteArray = "capture\u0000$via\u0000$at".toByteArray(Charsets.UTF_8)

    fun phoneAad(device: String, nonce: String): ByteArray = "phone\u0000$device\u0000$nonce".toByteArray(Charsets.UTF_8)

    private fun x25519Shared(privateKey: ByteArray, publicKey: ByteArray): ByteArray {
        val agreement = X25519Agreement()
        agreement.init(X25519PrivateKeyParameters(privateKey, 0))
        val shared = ByteArray(agreement.agreementSize)
        agreement.calculateAgreement(X25519PublicKeyParameters(publicKey, 0), shared, 0)
        return shared
    }

    private fun boxKey(shared: ByteArray, epk: String, recipient: String): ByteArray {
        val salt = Base64Url.decode(epk) + Base64Url.decode(recipient)
        val hkdf = HKDFBytesGenerator(SHA256Digest())
        hkdf.init(HKDFParameters(shared, salt, SEAL_INFO.toByteArray(Charsets.UTF_8)))
        return ByteArray(32).also { hkdf.generateBytes(it, 0, 32) }
    }
}
