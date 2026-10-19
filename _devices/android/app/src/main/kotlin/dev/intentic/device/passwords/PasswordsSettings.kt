package dev.intentic.device.passwords

import dev.intentic.device.store.KeyValue

/** Which computer saved passwords go to, and fingerprints shown after pairing. */
class PasswordsSettings(private val kv: KeyValue) {
    var saveToKeyring: String?
        get() = kv.getString("passwords.saveTo")
        set(value) = kv.putString("passwords.saveTo", value)

    fun pairedFingerprint(keyringDevice: String): String? = kv.getString("passwords.paired.$keyringDevice.fp")

    fun setPairedFingerprint(keyringDevice: String, fingerprint: String) {
        kv.putString("passwords.paired.$keyringDevice.fp", fingerprint)
    }

    fun isPaired(keyringDevice: String): Boolean = kv.getBoolean("passwords.paired.$keyringDevice", false)

    fun setPaired(keyringDevice: String, paired: Boolean) {
        kv.putBoolean("passwords.paired.$keyringDevice", paired)
    }
}
