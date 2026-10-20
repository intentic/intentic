package dev.intentic.app.secret

import java.io.File
import java.security.SecureRandom
import java.util.Base64

/**
 * The 32 random bytes the core seals its sessions with (`Config.secretKey`), kept on disk only wrapped by [wrap].
 *
 * [file] belongs in noBackupFilesDir: a backup restored onto another phone carries the store but neither this file
 * nor the Keystore key, so the core starts with a fresh secret and reads its old sessions as signed out. The same
 * happens when the file cannot be unwrapped any more. The raw bytes live only in memory and in the config handed to
 * the core: never log either.
 */
class CoreSecret(private val file: File, private val wrap: KeyWrap, private val random: SecureRandom = SecureRandom()) {
    /** The secret, base64 with padding, as the core's `Config.secretKey` takes it. */
    fun load(): String {
        val kept = if (file.isFile) wrap.unwrap(file.readText()) else null
        val secret = kept?.takeIf { it.size == SIZE } ?: create()
        return Base64.getEncoder().encodeToString(secret)
    }

    private fun create(): ByteArray {
        val secret = ByteArray(SIZE).also(random::nextBytes)
        // Written aside and renamed over, so a process killed mid-write leaves the old file or the new one, never half.
        val partial = File(file.parentFile, "${file.name}.partial")
        partial.writeText(wrap.wrap(secret))
        check(partial.renameTo(file)) { "could not keep the core's secret in ${file.path}" }
        return secret
    }

    private companion object {
        const val SIZE = 32
    }
}
