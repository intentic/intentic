package dev.intentic.app.conversation

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.browser.customtabs.CustomTabsIntent
import dev.intentic.app.BuildConfig
import dev.intentic.app.R
import dev.intentic.app.core.CardAnswer
import dev.intentic.app.core.Calls
import dev.intentic.app.core.Core
import dev.intentic.app.core.CoreStart
import dev.intentic.app.core.Event
import dev.intentic.app.core.Outcome
import dev.intentic.app.core.Request
import dev.intentic.app.core.RequestAnswerInner
import dev.intentic.app.core.RequestCloseConversationInner
import dev.intentic.app.core.RequestOlderRowsInner
import dev.intentic.app.core.RequestOpenConversationInner
import dev.intentic.app.core.RequestSendInner
import dev.intentic.app.core.RequestSteerInner
import dev.intentic.app.core.RequestStopInner
import dev.intentic.app.state.AppState
import dev.intentic.app.ui.Looks
import dev.intentic.app.ui.Ui
import dev.intentic.app.ui.fitKeyboard
import dev.intentic.app.ui.padForBars
import dev.intentic.app.web.WebActivity

/**
 * One agent's conversation: its rows ([TranscriptList]), the cards' buttons, and the composer. Without an agent it is a
 * new conversation, whose first Send names the agent.
 */
open class ConversationActivity : ComponentActivity(), CardActions {
    protected var agent: String? = null
    private lateinit var ui: Ui
    private lateinit var transcript: TranscriptList
    private lateinit var composer: Composer
    private lateinit var title: TextView
    private var madeIn = 0
    @Volatile private var listening: AutoCloseable? = null
    @Volatile private var early: AutoCloseable? = null
    private var watching: AutoCloseable? = null

    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        Looks.apply(this, base.resources.configuration)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        madeIn = Looks.generation
        agent = savedInstanceState?.getString(AGENT) ?: intent.getStringExtra(EXTRA_AGENT)
        ui = Ui(this)
        transcript = TranscriptList(this, ui, RowLook(this), this, agent, ::older, ::rowsDrawn)
        composer = Composer(ui, ::send, ::stop).apply {
            savedInstanceState?.getString(DRAFT)?.let { draft = it }
            // Words a page offered for this conversation: added to the draft, never sent by themselves.
            if (savedInstanceState == null) intent.getStringExtra(EXTRA_COMPOSE)?.let { offered -> draft = listOf(draft, offered).filter(String::isNotBlank).joinToString("\n") }
            padForBars(top = false)
        }
        val list = transcript.view.apply { layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f) }
        setContentView(FrameLayout(this).apply {
            fitKeyboard()
            setBackgroundColor(ui.color(R.color.canvas))
            addView(ui.column(bar(), list, composer), FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        })
        watching = AppState.watch { snapshot ->
            title.text = snapshot.board?.firstOrNull { it.id == agent }?.title
                ?: getString(if (agent == null) R.string.chat_words_new_agent else R.string.agents_agent_status_untitled_agent)
        }
        // The conversation is asked for the moment the core is up, from the thread that started it on a cold start, so
        // its rows are on their way while this screen draws its first, empty frame.
        val opening = agent
        if (opening != null) synchronized(following) { following[opening] = (following[opening] ?: 0) + 1 }
        CoreStart.then {
            if (isDestroyed) return@then
            listening = Core.observe(::heard)
            early = Core.observeEarly { event -> if (event is Event.Rows) transcript.early(event.content) }
            opening?.let(::open)
        }
    }

    /** Asks the core to follow [agent]'s conversation. A preview build's fixture opens its own instead. */
    protected open fun open(agent: String) {
        Calls.send(Request.OpenConversation(RequestOpenConversationInner(agent))) { outcome ->
            if (outcome is Outcome.Failed) composer.say(outcome.content.message)
        }
    }

    /**
     * Called once, while the first frame that shows rows is being drawn: the screen is in use once that frame is up,
     * which is what Android's time to full display (and Play's start times) count to. The preview also says its start
     * time from here.
     */
    protected open fun rowsDrawn(count: Int) = reportFullyDrawn()

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(AGENT, agent)
        outState.putString(DRAFT, composer.draft)
    }

    override fun onDestroy() {
        listening?.close()
        early?.close()
        watching?.close()
        transcript.close()
        if (isFinishing) agent?.let(::unfollow)
        super.onDestroy()
    }

    private fun heard(event: Event) {
        if (event is Event.Rows && event.content.agent == agent) {
            transcript.apply(event.content)
            composer.live(transcript.live)
        }
    }

    private fun older() {
        agent?.let { Calls.send(Request.OlderRows(RequestOlderRowsInner(it))) }
    }

    private fun send(text: String) {
        val to = agent
        val request = when {
            to == null -> Request.Send(RequestSendInner(agent = null, text = text, attachments = emptyList()))
            transcript.live -> Request.Steer(RequestSteerInner(agent = to, text = text))
            else -> Request.Send(RequestSendInner(agent = to, text = text, attachments = emptyList()))
        }
        composer.busy(true)
        Calls.send(request) { outcome ->
            composer.busy(false)
            when (outcome) {
                is Outcome.Failed -> composer.say(outcome.content.message)
                is Outcome.Sent -> {
                    composer.sent()
                    if (to == null) adopt(outcome.content.agent)
                }
                else -> composer.sent()
            }
        }
    }

    // A new conversation's first send named its agent: this screen is that agent's from now on.
    private fun adopt(named: String) {
        agent = named
        intent.putExtra(EXTRA_AGENT, named)
        transcript.agent = named
        follow(named)
    }

    private fun stop() {
        val to = agent ?: return
        Calls.send(Request.Stop(RequestStopInner(to))) { outcome ->
            if (outcome is Outcome.Failed) composer.say(outcome.content.message)
        }
    }

    override fun answer(answer: CardAnswer, failed: (String?) -> Unit) {
        Calls.send(Request.Answer(RequestAnswerInner(answer))) { outcome ->
            failed((outcome as? Outcome.Failed)?.content?.message)
        }
    }

    override fun openPage(pageId: String) {
        val to = agent ?: return
        WebActivity.open(this, WebActivity.onSandbox("/agents/${Uri.encode(to)}/pages/${Uri.encode(pageId)}", AppState.snapshot.open))
    }

    override fun openOnWeb() {
        val to = agent ?: return
        CustomTabsIntent.Builder().setShowTitle(true).build()
            .launchUrl(this, Uri.parse("${BuildConfig.WEB_URL.trimEnd('/')}/agents/${Uri.encode(to)}"))
    }

    // Two screens can show one agent (opened again from the board, or a notification): the core stops following it
    // only when the last one closes, so closing one cannot empty the other.
    private fun follow(agent: String) {
        synchronized(following) { following[agent] = (following[agent] ?: 0) + 1 }
        open(agent)
    }

    private fun unfollow(agent: String) {
        val last = synchronized(following) {
            val left = (following[agent] ?: 1) - 1
            if (left > 0) following[agent] = left else following.remove(agent)
            left <= 0
        }
        if (last) Calls.send(Request.CloseConversation(RequestCloseConversationInner(agent)))
    }

    // The web's own screens for this agent: its Changes, in the shared WebView.
    private fun showMenu(anchor: android.view.View) {
        val to = agent ?: return
        PopupMenu(this, anchor).apply {
            val changes = getString(R.string.shared_changes)
            menu.add(changes).setOnMenuItemClickListener {
                WebActivity.open(screen(), WebActivity.onSandbox("/agents/${Uri.encode(to)}?view=changes", AppState.snapshot.open), changes)
                true
            }
            show()
        }
    }

    // This screen, named once: inside a menu listener `this` is the menu item.
    private fun screen(): ConversationActivity = this

    override fun onResume() {
        super.onResume()
        Looks.refresh(this, madeIn)
    }

    private fun bar(): LinearLayout {
        val back = ui.iconButton(R.drawable.ic_back, getString(R.string.ui_action_back)) { finish() }
        title = ui.barTitle("").apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = ui.dp(4) }
        }
        val more = ui.iconButton(R.drawable.ic_more, getString(R.string.browsers_browsers_more), ::showMenu)
        return ui.row(back, title, more).apply {
            setPadding(ui.dp(4), ui.dp(4), ui.dp(4), ui.dp(4))
            padForBars(bottom = false)
        }
    }

    companion object {
        const val EXTRA_AGENT = "agent"
        const val EXTRA_COMPOSE = "compose"
        private const val AGENT = "agent"
        private const val DRAFT = "draft"
        // How many screens follow each agent; guarded by itself, since a screen opening on a cold start counts in on the
        // thread that started the core.
        private val following = HashMap<String, Int>()

        fun intent(context: Context, agent: String?, compose: String? = null): Intent =
            Intent(context, ConversationActivity::class.java).apply {
                agent?.let { putExtra(EXTRA_AGENT, it) }
                compose?.let { putExtra(EXTRA_COMPOSE, it) }
            }
    }
}
