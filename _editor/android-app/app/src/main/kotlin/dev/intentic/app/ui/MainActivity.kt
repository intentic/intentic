package dev.intentic.app.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewTreeObserver
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import dev.intentic.app.BuildConfig
import dev.intentic.app.auth.BrowserSignIn
import dev.intentic.app.auth.SignInView
import dev.intentic.app.board.BoardView
import dev.intentic.app.conversation.ConversationActivity
import dev.intentic.app.core.BoardCard
import dev.intentic.app.core.Calls
import dev.intentic.app.core.Request
import dev.intentic.app.core.RequestOpenSandboxInner
import dev.intentic.app.core.SessionState
import dev.intentic.app.state.AppState
import dev.intentic.app.state.Snapshot
import dev.intentic.app.web.AgentLink
import dev.intentic.app.web.WebActivity
import dev.intentic.app.web.WebHost
import java.io.File

/**
 * The app's one launcher activity: the sign-in screen while the core says nobody is signed in, the board once someone
 * is. It is also where the browser's `intentic://auth` link comes back to (singleTask, so the link lands here and the
 * browser tab above it closes).
 */
class MainActivity : ComponentActivity() {
    private lateinit var frame: FrameLayout
    private lateinit var browser: BrowserSignIn
    private var watching: AutoCloseable? = null
    private var signIn: SignInView? = null
    private var board: BoardView? = null
    private var madeIn = 0

    // A link back that arrived before the core had started: it is spent once the core has said who is signed in.
    private var handoff: Pair<String, String>? = null

    // A web link to an agent: opened once someone is signed in, which may be after signing in.
    private var agentLink: AgentLink? = null

    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        Looks.apply(this, base.resources.configuration)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        madeIn = Looks.generation
        browser = BrowserSignIn(File(noBackupFilesDir, "browser-sign-in"), BuildConfig.WEB_URL)
        frame = FrameLayout(this)
        frame.fitKeyboard()
        setContentView(frame)
        holdStartingWindow()
        watching = AppState.watch(::render)
        // Not again for the same link when the activity is only being remade, or reopened from Recents.
        if (savedInstanceState == null && intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY == 0) {
            arrived(intent)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        arrived(intent)
    }

    override fun onDestroy() {
        watching?.close()
        super.onDestroy()
    }

    /**
     * Keeps the system's starting window up until the core has said who is signed in, so neither screen flashes past
     * the other. The core says so within milliseconds of starting; past [HOLD_MS] the window is let go regardless.
     */
    private fun holdStartingWindow() {
        val since = SystemClock.uptimeMillis()
        frame.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                val known = AppState.snapshot.session != null || AppState.snapshot.failure != null
                if (known || SystemClock.uptimeMillis() - since > HOLD_MS) {
                    frame.viewTreeObserver.removeOnPreDrawListener(this)
                    return true
                }
                return false
            }
        })
    }

    private fun render(snapshot: Snapshot) {
        val failure = snapshot.failure
        when {
            failure != null -> {
                val ui = Ui(this)
                show(ui.body(failure).apply {
                    gravity = Gravity.CENTER
                    setPadding(ui.dp(32), 0, ui.dp(32), 0)
                })
            }
            snapshot.session is SessionState.SignedIn -> {
                signIn = null
                handoff = null
                val shown = board ?: BoardView(this, ::openAgent, ::newAgent).also {
                    board = it
                    show(it)
                    warmTheWeb()
                }
                shown.render(snapshot)
                agentLink?.let { link ->
                    agentLink = null
                    openLink(link, snapshot)
                }
            }
            snapshot.session is SessionState.SignedOut -> {
                board = null
                val shown = signIn ?: SignInView(this, browser).also { signIn = it; show(it) }
                handoff?.let { (id, verifier) ->
                    handoff = null
                    shown.redeem(id, verifier)
                }
            }
        }
    }

    // The shared WebView, made once the board has drawn and the main thread has nothing else to do: making one loads
    // the browser engine, a cost no start should wait for. Its page loads the workspace, the web screen most opened.
    private fun warmTheWeb() {
        frame.post {
            Looper.myQueue().addIdleHandler {
                WebHost.warm(applicationContext, WebActivity.onSandbox("/workspace", AppState.snapshot.open))
                false
            }
        }
    }

    override fun onResume() {
        super.onResume()
        Looks.refresh(this, madeIn)
    }

    private fun show(view: View) {
        frame.removeAllViews()
        frame.addView(view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    }

    /** `intentic://auth?handoff=…&state=…`: the browser's sign-in coming back; or a web link to an agent. */
    private fun arrived(intent: Intent?) {
        val link: Uri = intent?.data ?: return
        AgentLink.of(link.toString(), BuildConfig.WEB_URL)?.let {
            agentLink = it
            render(AppState.snapshot)
            return
        }
        if (link.scheme != "intentic" || link.host != "auth") {
            return
        }
        val id = link.getQueryParameter("handoff")
        val verifier = browser.finish(link.getQueryParameter("state"))
        if (id == null || verifier == null) {
            Log.w(TAG, "dropped a sign-in link this app did not ask for, or asked too long ago")
            return
        }
        handoff = id to verifier
        render(AppState.snapshot)
    }

    // The agent's conversation, natively, on the sandbox the link names (the core takes requests in order, so the
    // conversation opens on it); a page or the changes go over it on the shared WebView, Back returning to it.
    private fun openLink(link: AgentLink, snapshot: Snapshot) {
        val sandbox = link.sandbox ?: snapshot.open
        if (sandbox != null && sandbox != snapshot.open) {
            Calls.send(Request.OpenSandbox(RequestOpenSandboxInner(sandbox = sandbox)))
        }
        val conversation = ConversationActivity.intent(this, link.agent)
        val agent = Uri.encode(link.agent)
        val over = when {
            link.page != null -> "/agents/$agent/pages/${Uri.encode(link.page)}"
            link.changes -> "/agents/$agent?view=changes"
            else -> null
        }
        if (over == null) {
            startActivity(conversation)
        } else {
            startActivities(arrayOf(conversation, WebActivity.intent(this, WebActivity.onSandbox(over, sandbox))))
        }
    }

    // The one place a card opens: its conversation, native.
    private fun openAgent(card: BoardCard) = startActivity(ConversationActivity.intent(this, card.id))

    // The board's "New agent": an empty conversation whose first send names the agent.
    private fun newAgent() = startActivity(ConversationActivity.intent(this, null))

    private companion object {
        const val TAG = "MainActivity"
        const val HOLD_MS = 2_000L
    }
}
