package dev.intentic.app.conversation

import android.text.InputType
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import dev.intentic.app.R
import dev.intentic.app.core.CardAnswer
import dev.intentic.app.core.CardAnswerHelpInner
import dev.intentic.app.core.CardAnswerOfferInner
import dev.intentic.app.core.CardAnswerPermissionInner
import dev.intentic.app.core.CardAnswerPlanInner
import dev.intentic.app.core.CardAnswerQuestionInner
import dev.intentic.app.core.CardQuestion
import dev.intentic.app.core.CardRow
import dev.intentic.app.core.CardRowKind
import dev.intentic.app.core.OfferKind
import dev.intentic.app.core.PermissionDecision
import dev.intentic.app.ui.Ui

/** What a card's buttons do: answer it through the core, or open it on the web. */
interface CardActions {
    /** Sends [answer]; [failed] gets the core's message when it refuses, null when it took it. */
    fun answer(answer: CardAnswer, failed: (String?) -> Unit)

    /** Shows the agent's page [pageId] full screen, in the shared WebView. */
    fun openPage(pageId: String)

    /** The agent on the web, for a card the app has no page for. */
    fun openOnWeb()
}

/**
 * The buttons under a pending card, by its kind, as the web's cards offer them. A question's picks and typed words are
 * kept here by request id, so scrolling the card away and back keeps them.
 */
class CardButtons(private val ui: Ui, private val actions: CardActions) {
    private val context = ui.context
    private val picked = HashMap<String, HashMap<String, MutableSet<String>>>()
    private val typed = HashMap<String, HashMap<String, String>>()

    /** Fills [into] with [card]'s buttons, or a page's Open; nothing for an answered card. */
    fun fill(into: LinearLayout, card: CardRow?, page: Boolean, pageId: String?) {
        into.removeAllViews()
        val status = ui.body("").apply { visibility = View.GONE }
        val presses = ArrayList<View>()
        fun send(answer: CardAnswer) {
            presses.forEach { it.isEnabled = false }
            actions.answer(answer) { failed ->
                presses.forEach { it.isEnabled = true }
                status.visibility = if (failed == null) View.GONE else View.VISIBLE
                status.text = failed
                status.setTextColor(ui.color(R.color.danger))
            }
        }
        fun button(label: Int, tone: Ui.Tone = Ui.Tone.SECONDARY, text: String? = null, onClick: () -> Unit) =
            ui.button(text ?: context.getString(label), tone, onClick).also(presses::add)
        // A page, or a page's question: the page itself answers it, shown full screen by the web.
        if (page || card?.kind == CardRowKind.PageAsk) {
            into.addView(
                if (pageId != null) row(button(R.string.ui_action_open, Ui.Tone.PRIMARY) { actions.openPage(pageId) })
                else row(button(R.string.auth_desktop_auth_open_in_browser) { actions.openOnWeb() }),
            )
            return
        }
        if (card == null || !card.pending) return
        val id = card.requestId
        val views: List<View> = when (card.kind) {
            CardRowKind.Plan -> listOf(
                row(
                    button(R.string.ui_action_approve, Ui.Tone.PRIMARY) { send(CardAnswer.Plan(CardAnswerPlanInner(id, approve = true))) },
                    button(R.string.sandbox_environment_card_reject) { send(CardAnswer.Plan(CardAnswerPlanInner(id, approve = false))) },
                ),
            )
            CardRowKind.Question -> questions(card, presses) { answers ->
                send(CardAnswer.Question(CardAnswerQuestionInner(id, answers, cancelled = false)))
            }
            CardRowKind.Permission -> listOf(
                button(R.string.chat_chat_message_view_allow_once, Ui.Tone.PRIMARY) { send(permission(id, PermissionDecision.Once)) },
                button(R.string.sandbox_spawn_posture_always_allow, text = card.alwaysLabel) { send(permission(id, PermissionDecision.Always)) },
                button(R.string.ui_action_no) { send(permission(id, PermissionDecision.Deny)) },
            ).map { ui.spaced(it, top = 6) }
            CardRowKind.BrowserHelp, CardRowKind.TerminalHelp -> {
                val terminal = card.kind == CardRowKind.TerminalHelp
                listOf(
                    row(
                        button(R.string.ui_action_done, Ui.Tone.PRIMARY) { send(CardAnswer.Help(CardAnswerHelpInner(id, terminal, helped = true))) },
                        button(R.string.chat_chat_message_view_not_now) { send(CardAnswer.Help(CardAnswerHelpInner(id, terminal, helped = false))) },
                    ),
                )
            }
            CardRowKind.CapabilityOffer, CardRowKind.PaymentOffer, CardRowKind.CredentialOffer -> {
                val offer = when (card.kind) {
                    CardRowKind.PaymentOffer -> OfferKind.Payment
                    CardRowKind.CredentialOffer -> OfferKind.Credential
                    else -> OfferKind.Capability
                }
                listOf(
                    row(
                        button(R.string.views_vocabulary_accept, Ui.Tone.PRIMARY) { send(CardAnswer.Offer(CardAnswerOfferInner(id, offer, accept = true))) },
                        button(R.string.chat_chat_message_view_not_now) { send(CardAnswer.Offer(CardAnswerOfferInner(id, offer, accept = false))) },
                    ),
                )
            }
            CardRowKind.PageAsk -> emptyList()
        }
        views.forEach(into::addView)
        into.addView(ui.spaced(status, top = 6))
    }

    private fun permission(id: String, decision: PermissionDecision) = CardAnswer.Permission(CardAnswerPermissionInner(id, decision))

    // Each question's options as toggles (one at a time unless it is multi-select), a field for the person's own words,
    // and one Submit for them all.
    private fun questions(card: CardRow, presses: MutableList<View>, submit: (HashMap<String, List<String>>) -> Unit): List<View> {
        val picks = picked.getOrPut(card.requestId) { HashMap() }
        val words = typed.getOrPut(card.requestId) { HashMap() }
        val views = ArrayList<View>()
        for (question in card.questions) {
            question.header?.let { views.add(ui.spaced(ui.text(it, 13f, 600, R.color.muted), top = 10)) }
            val chosen = picks.getOrPut(question.question) { LinkedHashSet() }
            val toggles = ArrayList<Pair<String, android.widget.TextView>>()
            for (option in question.options) {
                val toggle = ui.button(option.label, Ui.Tone.SECONDARY) {}
                toggle.setOnClickListener {
                    if (!chosen.remove(option.label)) {
                        if (!question.multiSelect) chosen.clear()
                        chosen.add(option.label)
                    }
                    toggles.forEach { (label, view) -> mark(view, label in chosen) }
                }
                toggles.add(option.label to toggle)
                mark(toggle, option.label in chosen)
                presses.add(toggle)
                views.add(ui.spaced(toggle, top = 6))
                option.description?.let { views.add(ui.text(it, 13f, 400, R.color.muted).apply { setPadding(ui.dp(4), ui.dp(2), 0, 0) }) }
            }
            views.add(ui.spaced(own(question, words), top = 6))
        }
        val go = ui.button(context.getString(R.string.chat_chat_question_card_submit), Ui.Tone.PRIMARY) {
            val answers = HashMap<String, List<String>>()
            for (question in card.questions) {
                val mine = words[question.question]?.trim().orEmpty()
                val chosen = picks[question.question].orEmpty().toList()
                answers[question.question] = if (mine.isEmpty()) chosen else chosen + mine
            }
            submit(answers)
        }
        presses.add(go)
        views.add(ui.spaced(go, top = 10))
        return views
    }

    private fun own(question: CardQuestion, words: HashMap<String, String>): EditText =
        ui.field(context.getString(R.string.chat_chat_question_card_type_answer), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE).apply {
            isSingleLine = false
            setText(words[question.question].orEmpty())
            addTextChangedListener(object : android.text.TextWatcher {
                override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit

                override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) = Unit

                override fun afterTextChanged(text: android.text.Editable?) {
                    words[question.question] = text?.toString().orEmpty()
                }
            })
        }

    private fun mark(view: android.widget.TextView, chosen: Boolean) {
        view.background = ui.surface(if (chosen) R.color.primary_tint else R.color.card, stroke = if (chosen) R.color.accent else R.color.line_strong)
    }

    private fun row(vararg buttons: View): LinearLayout =
        ui.row(*buttons).apply {
            buttons.forEachIndexed { index, button ->
                button.layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                    if (index > 0) marginStart = ui.dp(8)
                }
            }
            setPadding(0, ui.dp(8), 0, 0)
        }
}
