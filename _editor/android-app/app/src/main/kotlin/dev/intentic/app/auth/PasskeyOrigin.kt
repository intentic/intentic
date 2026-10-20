package dev.intentic.app.auth

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.security.MessageDigest
import java.util.Base64

/**
 * The origin a passkey ceremony from this app carries, `android:apk-key-hash:<base64url SHA-256 of the signing
 * certificate>`: what the daemon admits for the editor's passkeys once app.intentic.dev's asset links list the same
 * certificate (the owner's ANDROID_APP_FINGERPRINTS). A debug, bench and store build each sign differently, so each
 * has its own.
 */
object PasskeyOrigin {
    fun of(certificate: ByteArray): String =
        "android:apk-key-hash:" + Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(certificate))

    /** This installed app's origin, or null when its certificate cannot be read. */
    fun installed(context: Context): String? = certificate(context)?.let(::of)

    @Suppress("DEPRECATION") // GET_SIGNATURES is the only way before API 28; the app signs with one key.
    private fun certificate(context: Context): ByteArray? {
        val packages = context.packageManager
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                packages.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
                    .signingInfo?.apkContentsSigners?.firstOrNull()?.toByteArray()
            } else {
                packages.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES).signatures?.firstOrNull()?.toByteArray()
            }
        } catch (error: PackageManager.NameNotFoundException) {
            null
        }
    }
}
