package dev.intentic.device.passwords

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import dev.intentic.device.store.AesGcmBox
import dev.intentic.device.store.KeyValue
import dev.intentic.device.store.SecretBox
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/**
 * The phone's Passwords keys: an X25519 seal pair (private half in [SecretBox]) and an EC P-256 presence key in the
 * Android Keystore that signs only after the person's biometric or screen lock.
 */
class PhoneKeys(private val kv: KeyValue, private val box: SecretBox) {
    data class Material(
        val deviceId: String,
        val label: String,
        val seal: Seal.KeyPair,
        val presenceSpkiBase64: String,
        val presenceFingerprint: String,
    )

    @Synchronized
    fun load(context: Context, deviceId: String, label: String): Material {
        ensurePresenceKey()
        val seal = loadSeal() ?: Seal.newKeyPair().also { saveSeal(it) }
        val presenceSpki = loadPresenceSpki()
        return Material(deviceId, label, seal, presenceSpki.first, presenceSpki.second)
    }

    fun signingSignature(context: Context): Signature {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val entry = store.getEntry(PRESENCE_ALIAS, null) as KeyStore.PrivateKeyEntry
        return Signature.getInstance("SHA256withECDSA").apply { initSign(entry.privateKey) }
    }

    private fun loadSeal(): Seal.KeyPair? {
        val pub = kv.getString("passwords.seal.pub") ?: return null
        val sealed = kv.getString("passwords.seal.priv") ?: return null
        val priv = box.open(sealed) ?: return null
        return Seal.KeyPair(pub, priv)
    }

    private fun saveSeal(pair: Seal.KeyPair) {
        kv.putString("passwords.seal.pub", pair.publicKey)
        kv.putString("passwords.seal.priv", box.seal(pair.privateKey))
    }

    private fun loadPresenceSpki(): Pair<String, String> {
        ensurePresenceKey()
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val cert = store.getCertificate(PRESENCE_ALIAS)
        val spki = cert.publicKey.encoded
        val spkiBase64 = Base64.getEncoder().encodeToString(spki)
        val digest = MessageDigest.getInstance("SHA-256").digest(spki)
        return spkiBase64 to fingerprint(digest)
    }

    private fun ensurePresenceKey() {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (store.containsAlias(PRESENCE_ALIAS)) {
            return
        }
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        val builder = KeyGenParameterSpec.Builder(PRESENCE_ALIAS, KeyProperties.PURPOSE_SIGN)
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setUserAuthenticationRequired(true)
        if (Build.VERSION.SDK_INT >= 30) {
            builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(-1)
        }
        generator.initialize(builder.build())
        generator.generateKeyPair()
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val PRESENCE_ALIAS = "intentic_passwords_presence"

        /** Groups of four hex digits, like the keyring shows its own fingerprint. */
        fun fingerprint(raw: ByteArray): String {
            val hex = raw.take(8).joinToString("") { byte -> "%02X".format(byte) }
            return hex.chunked(4).joinToString("-")
        }

        fun sealFingerprint(publicKey: String): String {
            val raw = Base64Url.decode(publicKey)
            return fingerprint(raw)
        }
    }
}
