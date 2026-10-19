package dev.intentic.device.passwords

import dev.intentic.device.store.AesGcmBox
import dev.intentic.device.store.KeyValue
import dev.intentic.device.store.SecretBox

/** Passwords wiring: HTTP client, preferences, and a short-lived cache of each computer's inbox key. */
class PasswordsHub(kv: KeyValue, box: SecretBox) {
    val client = PasswordsClient()
    val settings = PasswordsSettings(kv)
    val phoneKeys = PhoneKeys(kv, box)

    @Volatile
    private var keyrings: List<PasswordsClient.Keyring> = emptyList()

    @Volatile
    private var inboxByDevice: Map<String, String> = emptyMap()

    fun rememberKeyrings(rows: List<PasswordsClient.Keyring>) {
        keyrings = rows
        inboxByDevice = rows.mapNotNull { row -> row.inbox?.let { row.device to it } }.toMap()
    }

    fun inboxKey(device: String?): String? = device?.let { inboxByDevice[it] }

    /** First online, set-up, remembering computer the phone may save to. */
    fun defaultSaveTarget(): String? {
        val saved = settings.saveToKeyring
        if (saved != null && keyrings.any { it.device == saved && it.inbox != null && it.online && !it.locked }) {
            return saved
        }
        return keyrings.firstOrNull { it.inbox != null && it.remember && it.online && !it.locked }?.device
    }

    companion object {
        fun boxFrom(kv: KeyValue, key: () -> javax.crypto.SecretKey): PasswordsHub = PasswordsHub(kv, AesGcmBox(key))
    }
}
