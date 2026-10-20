package dev.intentic.app.board

import android.content.Context
import dev.intentic.app.R
import dev.intentic.app.core.LinkState

/** The slim line over the board that says how the link to the open sandbox stands, when it is not simply live. */
data class Banner(val text: String, val trouble: Boolean, val signInAgain: Boolean = false, val passkey: Passkey? = null)

/** A sandbox that opens only with a passkey: sign in with this person's, or add one when they have none yet. */
data class Passkey(val register: Boolean)

fun bannerOf(link: LinkState?, sandbox: String?, context: Context, ages: AgeText): Banner? =
    when (link) {
        null, LinkState.Live -> null
        LinkState.Connecting -> Banner(context.getString(R.string.sandbox_connection_notice_connecting_to, sandbox.orEmpty()), trouble = false)
        is LinkState.Reconnecting -> {
            val wait = ages.seconds(((link.content.retryInMs.toLong() + 999) / 1000).toInt())
            Banner("${context.getString(R.string.desktop_desktop_reconnecting)} ${context.getString(R.string.chat_chat_turn_status_retrying_in, wait)}", trouble = true)
        }
        // The core's own sentence: why the sandbox would not open for this account.
        is LinkState.Refused -> Banner(link.content.reason, trouble = true)
        LinkState.SignInRequired -> Banner(context.getString(R.string.shell_notification_sources_sign_in_again), trouble = true, signInAgain = true)
        is LinkState.PasskeyRequired -> {
            val enrolled = link.content.enrolled
            val words = if (enrolled) R.string.sandbox_sign_in_wall_use_passkey else R.string.sandbox_sign_in_wall_add_passkey_to_continue
            Banner(context.getString(words), trouble = true, passkey = Passkey(register = !enrolled))
        }
    }
