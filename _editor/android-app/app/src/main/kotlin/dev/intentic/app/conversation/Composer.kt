package dev.intentic.app.conversation

import android.annotation.SuppressLint
import android.text.InputType
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import dev.intentic.app.R
import dev.intentic.app.ui.Ui

/**
 * What the person writes into the conversation: a field that grows to six lines, Send (Steer turn while a run is
 * live, which the agent reads between its tool calls), and Stop turn while it is live. A failure the core answers with
 * shows above the field.
 */
@SuppressLint("ViewConstructor")
class Composer(private val ui: Ui, private val send: (String) -> Unit, private val stop: () -> Unit) : LinearLayout(ui.context) {
    private val context = ui.context
    private val notice = ui.text("", 13f, 400, R.color.danger).apply {
        visibility = View.GONE
        setPadding(ui.dp(4), 0, ui.dp(4), ui.dp(6))
    }
    private val input = ui.field(context.getString(R.string.chat_words_ask_anything), FIELD).apply {
        isSingleLine = false
        maxLines = 6
        layoutParams = LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
    }
    private val go: TextView = ui.button(context.getString(R.string.ui_action_send), Ui.Tone.PRIMARY) { submit() }.apply {
        layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { marginStart = ui.dp(8) }
    }
    private val halt: TextView = ui.button(context.getString(R.string.chat_composer_intent_stop_turn), Ui.Tone.SECONDARY) { stop() }.apply {
        visibility = View.GONE
    }

    init {
        orientation = VERTICAL
        setPadding(ui.dp(12), ui.dp(8), ui.dp(12), ui.dp(8))
        setBackgroundColor(ui.color(R.color.canvas))
        addView(notice)
        addView(ui.spaced(halt, bottom = 8))
        addView(ui.row(input, go).apply { gravity = android.view.Gravity.BOTTOM })
    }

    var draft: String
        get() = input.text.toString()
        set(value) = input.setText(value)

    private var running: Boolean? = null

    // Told on every Rows event, so it changes the views only when the state does: setting a label lays the whole screen
    // out again, sixty times a second while a turn streams.
    fun live(running: Boolean) {
        if (this.running == running) return
        this.running = running
        halt.visibility = if (running) View.VISIBLE else View.GONE
        go.text = context.getString(if (running) R.string.chat_composer_intent_hint_steer else R.string.ui_action_send)
    }

    fun busy(waiting: Boolean) {
        go.isEnabled = !waiting
        go.alpha = if (waiting) 0.6f else 1f
    }

    fun sent() {
        input.text.clear()
        say(null)
    }

    fun say(message: String?) {
        notice.visibility = if (message == null) View.GONE else View.VISIBLE
        notice.text = message
    }

    private fun submit() {
        val text = input.text.toString().trim()
        if (text.isNotEmpty()) send(text)
    }

    private companion object {
        const val FIELD = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    }
}
