package dev.intentic.device.ui

import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import dev.intentic.device.Graph
import dev.intentic.device.link.OkHttpSockets
import dev.intentic.device.protocol.EnrollResult
import dev.intentic.device.protocol.Enrollment
import dev.intentic.device.protocol.PhoneWire
import dev.intentic.device.store.Pairing
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/**
 * Pairs this phone with a sandbox. It opens from the pairing link or QR code (intentic.dev/phone/pair, or
 * intentic-device://pair, with the code in the fragment) or from a pasted code. Nothing is sent until the owner has read the
 * sandbox's address and tapped the button: a link anyone can send must not be able to pair the phone by being opened.
 */
class PairActivity : AppCompatActivity() {
    private lateinit var ui: Ui
    private lateinit var content: LinearLayout
    private var pending: PhoneWire.Pairing? = null
    private var message: String? = null
    private var enrolling = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "Pair this phone"
        ui = Ui(this)
        content = ui.column().apply { setPadding(ui.dp(16), ui.dp(8), ui.dp(16), ui.dp(24)) }
        val scroll = ScrollView(this).apply { addView(content) }
        setContentView(scroll)
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, 0, bars.right, bars.bottom)
            insets
        }
        read(intent)
        render()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        read(intent)
        render()
    }

    /** The code a link carried, if this was opened by one. Everything after the `#` is the code. */
    private fun read(from: Intent) {
        val link = from.dataString ?: return
        val parsed = PhoneWire.parsePairingCode(link)
        pending = parsed
        message = if (parsed == null) "That link is not a pairing code this app can read. Copy a fresh one from your sandbox's phone card." else null
    }

    private fun render() {
        content.removeAllViews()
        val existing = Graph.pairings.get()
        val found = pending
        content.addView(ui.title("Pair this phone"))
        content.addView(ui.body("Your sandbox shows a pairing code or a QR code on the phone's card. Scan the QR code with the camera, or paste the code or link here."))
        message?.let { content.addView(ui.body(it)) }

        if (found != null) {
            val host = Graph.hostOf(found.url)
            content.addView(ui.heading("Pair with this sandbox?"))
            content.addView(ui.body(found.url))
            if (!found.url.startsWith("https://")) {
                content.addView(ui.body("This address does not use https, so what it sends would not be private. This app only pairs with https sandboxes."))
            } else {
                content.addView(ui.body("Only continue if this is your own sandbox. Once paired, your agent there can use this phone only as far as you allow, and you can pause or unpair at any time.", muted = true))
                if (existing != null) {
                    content.addView(ui.body("This replaces your current pairing with ${Graph.hostOf(existing.sandboxUrl)}."))
                }
                val pair = ui.button(if (enrolling) "Pairing..." else "Pair with $host") { enroll(found) }
                pair.isEnabled = !enrolling
                content.addView(pair)
            }
            content.addView(ui.button("Cancel") {
                pending = null
                message = null
                render()
            })
        } else {
            val paste = EditText(this).apply {
                hint = "Paste the pairing code or link"
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
                minLines = 3
                tag = "paste"
            }
            content.addView(paste)
            content.addView(ui.button("Continue") {
                val parsed = PhoneWire.parsePairingCode(paste.text.toString())
                pending = parsed
                message = if (parsed == null) "That is not a pairing code. It starts with ixp1_ and comes from your sandbox's phone card." else null
                render()
            })
            if (existing != null) {
                content.addView(ui.body("Already paired with ${Graph.hostOf(existing.sandboxUrl)}. A new pairing replaces it, after you confirm.", muted = true))
            }
        }
    }

    private fun enroll(found: PhoneWire.Pairing) {
        if (enrolling || !found.url.startsWith("https://")) {
            return
        }
        enrolling = true
        message = null
        render()
        Thread({
            val result = try {
                OkHttpSockets.client().newCall(
                    Request.Builder().url(PhoneWire.enrollUrl(found.url)).header(PhoneWire.PAIR_HEADER, found.token).post("".toRequestBody()).build(),
                ).execute().use { Enrollment.interpret(it.code, it.body.string()) }
            } catch (error: IOException) {
                EnrollResult.Refused("Could not reach ${Graph.hostOf(found.url)}: ${error.message ?: "no answer"}.")
            }
            runOnUiThread {
                enrolling = false
                when (result) {
                    is EnrollResult.Enrolled -> {
                        Graph.pair(Pairing(found.url, result.id, result.token))
                        Graph.connect(this)
                        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                        finish()
                    }
                    is EnrollResult.Refused -> {
                        message = result.message
                        render()
                    }
                }
            }
        }, "intentic-enroll").start()
    }
}
