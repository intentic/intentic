package dev.intentic.app.board

import android.content.res.ColorStateList
import android.text.TextUtils
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import dev.intentic.app.R
import dev.intentic.app.core.BoardCard
import dev.intentic.app.ui.Ui

/**
 * One agent's card on the board, as the web board's card reads at a glance: its title, what it is doing (or what failed, or its
 * status), whether it has news, whether a turn is running, how long ago it last moved, and its checklist.
 */
class AgentCard(private val ui: Ui) : LinearLayout(ui.context) {
    private val unread = ui.dot(R.color.accent).apply {
        layoutParams = LayoutParams(ui.dp(8), ui.dp(8)).apply { marginEnd = ui.dp(8) }
    }
    private val title = ui.text("", 16f, 600, R.color.content).apply {
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
        layoutParams = LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
    }
    private val working = ProgressBar(ui.context, null, android.R.attr.progressBarStyleSmall).apply {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        indeterminateTintList = ColorStateList.valueOf(ui.color(R.color.accent))
        layoutParams = LayoutParams(ui.dp(18), ui.dp(18)).apply { marginStart = ui.dp(8) }
    }
    private val age = ui.text("", 12f, 400, R.color.subtle).apply {
        layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { marginStart = ui.dp(8) }
    }
    private val line = ui.text("", 14f, 400, R.color.muted).apply {
        maxLines = 2
        ellipsize = TextUtils.TruncateAt.END
        layoutParams = LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
    }
    private val steps = ui.text("", 12f, 500, R.color.muted, R.font.jetbrains_mono).apply {
        layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { marginStart = ui.dp(8) }
    }

    init {
        orientation = VERTICAL
        background = ui.surface(R.color.card, radius = 12, stroke = R.color.line_subtle)
        setPadding(ui.dp(14), ui.dp(12), ui.dp(14), ui.dp(12))
        isClickable = true
        isFocusable = true
        addView(ui.row(unread, title, working, age))
        addView(ui.row(line, steps).apply { setPadding(0, ui.dp(4), 0, 0) })
        // The card is one stop for TalkBack, read from its description; its pieces are not stops of their own.
        for (piece in listOf(title, age, line, steps)) piece.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun bind(card: BoardCard, ages: AgeText, now: Long) {
        title.text = card.title?.takeIf { it.isNotBlank() } ?: context.getString(R.string.agents_agent_status_untitled_agent)
        val failed = card.activity == null && card.failure != null
        line.text = card.activity ?: card.failure ?: card.status
        line.setTextColor(ui.color(if (failed) R.color.danger else R.color.muted))
        unread.visibility = if (card.unread) View.VISIBLE else View.GONE
        working.visibility = if (card.working) View.VISIBLE else View.GONE
        age.text = ages.of(ageOf(card.updatedAt, now))
        age.visibility = if (card.updatedAt > 0) View.VISIBLE else View.GONE
        val total = card.checklistTotal
        steps.text = if (total == null) "" else "${minOf(card.checklistDone ?: 0u, total)}/$total"
        steps.visibility = if (total == null) View.GONE else View.VISIBLE
        // One stop for TalkBack: what the card says, its status when the line shows something else, and its age.
        contentDescription = listOfNotNull(title.text, line.text, card.status.takeIf { it != line.text }, age.text, steps.text.takeIf { total != null })
            .joinToString(", ")
    }
}
