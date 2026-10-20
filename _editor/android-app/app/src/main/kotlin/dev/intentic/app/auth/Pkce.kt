package dev.intentic.app.auth

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** RFC 7636's proof key, as the desktop app makes it (`auth.rs`) and the platform checks it (`desktop.routes.ts`). */
object Pkce {
    private val base64Url = Base64.getUrlEncoder().withoutPadding()

    /** 64 characters of base64url from 48 random bytes, inside the 43–128 the RFC allows. */
    fun verifier(random: SecureRandom = SecureRandom()): String = base64Url.encodeToString(ByteArray(48).also(random::nextBytes))

    /** S256: the verifier's SHA-256, base64url without padding. */
    fun challenge(verifier: String): String =
        base64Url.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
}
