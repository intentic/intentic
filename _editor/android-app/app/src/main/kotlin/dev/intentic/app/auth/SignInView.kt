package dev.intentic.app.auth

import android.app.Activity
import android.net.Uri
import android.view.Gravity
import android.view.View
import android.widget.ScrollView
import androidx.browser.customtabs.CustomTabsIntent
import dev.intentic.app.R
import dev.intentic.app.core.Calls
import dev.intentic.app.core.Outcome
import dev.intentic.app.core.Request
import dev.intentic.app.core.RequestRedeemHandoffInner
import dev.intentic.app.core.RequestSignInWithGoogleInner
import dev.intentic.app.ui.Ui
import dev.intentic.app.ui.padForBars

/**
 * The signed-out screen, with the web login's three ways in: Google's own sheet, an emailed code, and the browser. Each
 * ends in a core request; the core's Session event, not this screen, is what moves the app on to the board.
 */
class SignInView(private val activity: Activity, private val browser: BrowserSignIn) : ScrollView(activity) {
    private val ui = Ui(activity)
    private val status = ui.body("").apply { visibility = View.GONE }
    private val email = EmailSignIn(ui, ::say, ::busy)
    private val google = ui.button(activity.getString(R.string.auth_words_continue_google)) { withGoogle() }
    private val inBrowser = ui.button(activity.getString(R.string.sandbox_sign_in_wall_continue_in_browser), Ui.Tone.QUIET) { openBrowser() }

    init {
        isFillViewport = true
        val or = ui.text(activity.getString(R.string.auth_login_or), 14f, 400, R.color.subtle).apply { gravity = Gravity.CENTER }
        val content = ui.column(
            ui.title(activity.getString(R.string.auth_login_welcome_to_intentic)),
            ui.lead(activity.getString(R.string.auth_login_workspace_coding_agents)),
            google,
            ui.spaced(or, top = 16, bottom = 16),
            email.view,
            ui.spaced(inBrowser, top = 16),
            ui.spaced(status, top = 16),
        )
        content.setPadding(ui.dp(24), ui.dp(56), ui.dp(24), ui.dp(24))
        content.padForBars()
        addView(content)
    }

    /** The browser's link back arrived: spend its handoff with the verifier this app kept. */
    fun redeem(handoff: String, verifier: String) {
        busy(true)
        say(activity.getString(R.string.auth_desktop_auth_complete_signing_in), failure = false)
        Calls.send(Request.RedeemHandoff(RequestRedeemHandoffInner(handoff = handoff, verifier = verifier))) { outcome ->
            busy(false)
            if (outcome is Outcome.Failed) say(outcome.content.message)
        }
    }

    private fun withGoogle() {
        busy(true)
        say(null)
        GoogleSignIn(activity).start(
            token = { idToken ->
                Calls.send(Request.SignInWithGoogle(RequestSignInWithGoogleInner(idToken = idToken))) { outcome ->
                    busy(false)
                    if (outcome is Outcome.Failed) say(outcome.content.message)
                }
            },
            failed = { why ->
                busy(false)
                say(why)
            },
        )
    }

    private fun openBrowser() {
        say(activity.getString(R.string.auth_words_finish_in_browser), failure = false)
        inBrowser.text = activity.getString(R.string.auth_words_open_browser_again)
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, Uri.parse(browser.begin()))
    }

    private fun say(text: String?, failure: Boolean = true) {
        status.visibility = if (text == null) View.GONE else View.VISIBLE
        status.text = text
        status.setTextColor(ui.color(if (failure) R.color.danger else R.color.muted))
    }

    // One call at a time: while one is out, every way in waits.
    private fun busy(working: Boolean) {
        for (way in listOf(google, inBrowser)) {
            way.isEnabled = !working
            way.alpha = if (working) 0.6f else 1f
        }
        email.hold(working)
    }
}
