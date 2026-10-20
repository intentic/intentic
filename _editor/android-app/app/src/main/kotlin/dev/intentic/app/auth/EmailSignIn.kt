package dev.intentic.app.auth

import android.os.Handler
import android.os.Looper
import android.text.InputFilter
import android.text.InputType
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.LinearLayout
import androidx.core.widget.doAfterTextChanged
import dev.intentic.app.R
import dev.intentic.app.core.Calls
import dev.intentic.app.core.Outcome
import dev.intentic.app.core.OutcomeFailedInner
import dev.intentic.app.core.Request
import dev.intentic.app.core.RequestSendEmailCodeInner
import dev.intentic.app.core.RequestSignInWithEmailCodeInner
import dev.intentic.app.ui.Ui

/**
 * Sign-in by emailed code, in the web's two steps (EmailCodeSignIn.vue): an address and "Email me a sign-in code",
 * then the six digits, sent as soon as the sixth is typed. [say] shows the core's answer when a step fails; [busy]
 * holds the screen's other ways in while a call is out.
 */
class EmailSignIn(private val ui: Ui, private val say: (String?) -> Unit, private val busy: (Boolean) -> Unit) {
    private val context = ui.context
    private val main = Handler(Looper.getMainLooper())
    private var email = ""
    private var resendAt = 0L
    private val ticking = Runnable { tick() }

    private val address = ui.field(context.getString(R.string.auth_email_sign_in_address_placeholder), EMAIL).apply {
        setAutofillHints(View.AUTOFILL_HINT_EMAIL_ADDRESS)
        imeOptions = EditorInfo.IME_ACTION_SEND
        setOnEditorActionListener { _, _, _ -> sendCode().let { true } }
    }
    private val sentTo = ui.body("")
    private val code = ui.field(context.getString(R.string.auth_email_sign_in_code_label), InputType.TYPE_CLASS_NUMBER).apply {
        // Both, so a code read off the mail notification or an SMS-style suggestion strip can fill it.
        setAutofillHints("emailOTPCode", "smsOTPCode")
        filters = arrayOf(InputFilter.LengthFilter(CODE_LENGTH))
        imeOptions = EditorInfo.IME_ACTION_DONE
        setOnEditorActionListener { _, _, _ -> signIn().let { true } }
        typeface = ui.face(R.font.jetbrains_mono, 400)
        doAfterTextChanged {
            // The digits spaced like the code in the email; the hint left as words.
            letterSpacing = if (it.isNullOrEmpty()) 0f else 0.3f
            if (it?.length == CODE_LENGTH) signIn()
        }
    }
    private val send = ui.button(context.getString(R.string.auth_email_sign_in_email_me_code), Ui.Tone.SECONDARY) { sendCode() }
    private val signInButton = ui.button(context.getString(R.string.ui_action_sign_in)) { signIn() }
    private val different = ui.button(context.getString(R.string.auth_email_sign_in_use_different_address), Ui.Tone.QUIET) { showAsk() }
    private val again = ui.button(context.getString(R.string.auth_email_sign_in_send_again), Ui.Tone.QUIET) { sendCode() }

    private val ask = ui.column(
        ui.spaced(ui.text(context.getString(R.string.auth_email_sign_in_address_label), 14f, 500, R.color.muted), bottom = 6),
        address,
        ui.spaced(send, top = 12),
    )
    private val enter = ui.column(
        sentTo,
        ui.spaced(ui.body(context.getString(R.string.auth_email_sign_in_type_it_here_in_app), muted = true), top = 4, bottom = 12),
        code,
        ui.spaced(signInButton, top = 12),
        ui.spaced(again, top = 4),
        different,
    ).apply { visibility = View.GONE }

    val view: LinearLayout = ui.column(ask, enter)

    private val presses = listOf(address, code, send, signInButton, different)
    private var held = false

    /** Holds every field and button while a call is out, the resend wait aside. */
    fun hold(on: Boolean) {
        held = on
        presses.forEach { it.isEnabled = !on }
        tick()
    }

    private fun sendCode() {
        val typed = address.text.toString().trim()
        if (!typed.contains('@')) {
            address.requestFocus()
            return
        }
        busy(true)
        say(null)
        Calls.send(Request.SendEmailCode(RequestSendEmailCodeInner(email = typed))) { outcome ->
            busy(false)
            if (outcome is Outcome.Failed) {
                say(sentence(outcome.content))
            } else {
                email = typed
                resendAt = System.currentTimeMillis() + RESEND_AFTER_MS
                showEnter()
            }
        }
    }

    private fun signIn() {
        val digits = code.text.toString()
        if (digits.length != CODE_LENGTH) {
            return
        }
        busy(true)
        say(null)
        // Done needs nothing here: the core's Session event takes the app to the board.
        Calls.send(Request.SignInWithEmailCode(RequestSignInWithEmailCodeInner(email = email, code = digits))) { outcome ->
            busy(false)
            if (outcome is Outcome.Failed) {
                say(sentence(outcome.content))
                code.text.clear()
            }
        }
    }

    // The web's own sentences for Better Auth's refusals (client/auth/emailCode.ts); anything else in the core's words.
    private fun sentence(failed: OutcomeFailedInner): String =
        when (failed.code) {
            "INVALID_OTP" -> context.getString(R.string.auth_email_code_invalid)
            "OTP_EXPIRED" -> context.getString(R.string.auth_email_code_expired)
            "TOO_MANY_ATTEMPTS" -> context.getString(R.string.auth_email_code_too_many_attempts)
            "TOO_MANY_REQUESTS", "RATE_LIMITED" -> context.getString(R.string.auth_email_code_rate_limited)
            else -> failed.message
        }

    private fun showAsk() {
        enter.visibility = View.GONE
        ask.visibility = View.VISIBLE
        say(null)
    }

    private fun showEnter() {
        sentTo.text = context.getString(R.string.auth_email_sign_in_sent_to, email)
        code.text.clear()
        ask.visibility = View.GONE
        enter.visibility = View.VISIBLE
        code.requestFocus()
        tick()
    }

    // The web's resend wait, counted down on the button.
    private fun tick() {
        val left = ((resendAt - System.currentTimeMillis() + 999) / 1000).coerceAtLeast(0)
        again.isEnabled = left == 0L && !held
        again.alpha = if (again.isEnabled) 1f else 0.6f
        again.text = if (left == 0L) {
            context.getString(R.string.auth_email_sign_in_send_again)
        } else {
            context.getString(R.string.auth_email_sign_in_send_again_in, left.toString())
        }
        main.removeCallbacks(ticking)
        if (left > 0 && enter.isAttachedToWindow) {
            main.postDelayed(ticking, 1_000)
        }
    }

    private companion object {
        const val CODE_LENGTH = 6
        const val EMAIL = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
        // useEmailCode.ts's RESEND_AFTER_MS.
        const val RESEND_AFTER_MS = 60_000L
    }
}
