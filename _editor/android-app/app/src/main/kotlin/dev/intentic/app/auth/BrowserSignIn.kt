package dev.intentic.app.auth

import java.io.File
import java.util.UUID

/**
 * Signing in through the browser: the desktop app's PKCE handoff (`_editor/desktop-app/src-tauri/src/auth.rs`), from a
 * phone. [begin] opens the web's `/desktop-auth` with a nonce and a challenge; the page signs in there (Google, or an
 * emailed code) and parks the session for one pickup, then sends `intentic://auth?handoff=…&state=…` back. [finish]
 * matches the nonce and hands back the verifier only this app held, which the core spends with the handoff.
 *
 * The attempt is kept in [file] (in noBackupFilesDir), not only in memory: a phone short of memory often kills the app
 * while the browser is in front, and the link back then starts a new process.
 */
class BrowserSignIn(private val file: File, private val webUrl: String, private val now: () -> Long = System::currentTimeMillis) {
    /** The page to open: the same URL the desktop app opens. */
    fun begin(): String {
        val state = UUID.randomUUID().toString()
        val verifier = Pkce.verifier()
        file.writeText("$state\n$verifier\n${now()}")
        return "${webUrl.trimEnd('/')}/desktop-auth?state=$state&challenge=${Pkce.challenge(verifier)}"
    }

    /** The verifier for a link back carrying [state], or null for a link this app did not ask for or asked too long ago. */
    fun finish(state: String?): String? {
        val kept = if (file.isFile) file.readText().split('\n') else return null
        if (kept.size != 3 || state == null || kept[0] != state) {
            return null
        }
        file.delete()
        val startedAt = kept[2].toLongOrNull() ?: return null
        return kept[1].takeIf { now() - startedAt in 0..ATTEMPT_TTL_MS }
    }

    private companion object {
        // Longer than the desktop app's three minutes: a phone signing in by emailed code switches to its mail and back.
        // The handoff the page parks still expires three minutes after it is made (desktop.routes.ts).
        const val ATTEMPT_TTL_MS = 15 * 60_000L
    }
}
