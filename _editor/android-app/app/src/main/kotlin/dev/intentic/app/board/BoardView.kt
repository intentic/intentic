package dev.intentic.app.board

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.TextView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import dev.intentic.app.R
import dev.intentic.app.auth.Passkeys
import dev.intentic.app.core.BoardCard
import dev.intentic.app.core.Calls
import dev.intentic.app.core.Request
import dev.intentic.app.core.RequestOpenSandboxInner
import dev.intentic.app.core.SessionState
import dev.intentic.app.state.Snapshot
import dev.intentic.app.ui.Ui
import dev.intentic.app.ui.padForBars
import dev.intentic.app.web.WebActivity

/**
 * The signed-in home: the open sandbox's name (which opens the switcher) and the menu, the link's banner when it is
 * not simply live, and the board's lanes. Pulling down asks the platform for the sandboxes again.
 */
class BoardView(private val activity: Activity, open: (BoardCard) -> Unit, newAgent: () -> Unit) : LinearLayout(activity) {
    private val ui = Ui(activity)
    private val ages = AgeText(activity)
    private val cards = BoardAdapter(ui, open)
    private val sheet = SandboxSheet(activity) { sandbox -> Calls.send(Request.OpenSandbox(RequestOpenSandboxInner(sandbox = sandbox.id))) }
    private val main = Handler(Looper.getMainLooper())
    private var snapshot = Snapshot()

    private val name = ui.text("", 18f, 600, R.color.content).apply {
        setCompoundDrawablesRelativeWithIntrinsicBounds(null, null, ui.icon(R.drawable.ic_expand, R.color.muted), null)
        compoundDrawablePadding = ui.dp(4)
        minHeight = ui.dp(48)
        gravity = Gravity.CENTER_VERTICAL
        setOnClickListener { sheet.show(snapshot.sandboxes, snapshot.open) }
        background = ui.ripple()
        maxLines = 1
        ellipsize = android.text.TextUtils.TruncateAt.END
        // Short of the menu's room, which a long name measured first would otherwise take.
        maxWidth = activity.resources.displayMetrics.widthPixels - ui.dp(96)
    }
    private val menu = ui.iconButton(R.drawable.ic_more, activity.getString(R.string.shared_menu)) { showMenu(it) }
    private val banner = ui.text("", 14f, 500, R.color.content).apply {
        setPadding(ui.dp(20), ui.dp(8), ui.dp(20), ui.dp(8))
        visibility = View.GONE
    }
    private val empty = ui.body("", muted = true).apply {
        gravity = Gravity.CENTER
        setPadding(ui.dp(32), ui.dp(32), ui.dp(32), ui.dp(32))
    }
    private val list = RecyclerView(activity).apply {
        layoutManager = LinearLayoutManager(activity)
        adapter = cards
        clipToPadding = false
        setPadding(0, ui.dp(4), 0, ui.dp(88))
    }
    private val refresh = SwipeRefreshLayout(activity).apply {
        addView(list)
        setColorSchemeColors(ui.color(R.color.accent))
        setProgressBackgroundColorSchemeColor(ui.color(R.color.overlay))
        setOnRefreshListener {
            Calls.send(Request.RefreshSandboxes) { isRefreshing = false }
        }
    }
    // The web phone board's floating "New agent", over the list's bottom end.
    private val start = ui.button(activity.getString(R.string.chat_words_new_agent)) { newAgent() }.apply {
        setCompoundDrawablesRelativeWithIntrinsicBounds(ui.icon(R.drawable.ic_add, R.color.fill_content), null, null, null)
        compoundDrawablePadding = ui.dp(6)
        background = android.graphics.drawable.RippleDrawable(
            android.content.res.ColorStateList.valueOf(ui.color(R.color.primary_tint)),
            ui.surface(R.color.primary_fill, radius = 28),
            null,
        )
        elevation = ui.dp(4).toFloat()
        setPadding(ui.dp(18), ui.dp(12), ui.dp(22), ui.dp(12))
    }
    private val ticking = object : Runnable {
        override fun run() {
            cards.tick(System.currentTimeMillis())
            main.postDelayed(this, MINUTE)
        }
    }

    init {
        orientation = VERTICAL
        // The name only as wide as itself, so its chevron sits beside it; the space after it pushes the menu to the end.
        val bar = ui.row(name, View(activity).apply { layoutParams = LayoutParams(0, 0, 1f) }, menu).apply {
            setPadding(ui.dp(20), ui.dp(4), ui.dp(8), ui.dp(4))
        }
        name.layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, 0f)
        bar.padForBars(bottom = false)
        list.padForBars(top = false)
        addView(bar)
        addView(banner)
        val above = FrameLayout(activity).apply {
            addView(start, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
                setMargins(ui.dp(16), ui.dp(16), ui.dp(16), ui.dp(16))
            })
            padForBars(top = false)
        }
        addView(FrameLayout(activity).apply {
            addView(refresh)
            addView(empty, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
            addView(above)
        }, LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
    }

    fun render(next: Snapshot) {
        snapshot = next
        name.text = next.openSandbox?.name ?: activity.getString(R.string.sandbox_sandbox_switcher_sandboxes)
        val rows = boardRows(next.board.orEmpty())
        cards.submitList(rows)
        empty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
        empty.text = activity.getString(
            if (next.open == null) R.string.sandbox_use_sandbox_liveness_no_sandbox_selected else R.string.agents_agents_view_no_agents_working_start,
        )
        // Nothing to say before the core has said this sandbox's board, kept or fresh.
        if (next.open != null && next.board == null) empty.visibility = View.GONE
        showBanner(bannerOf(next.link, next.openSandbox?.name, activity, ages))
    }

    private fun showBanner(shown: Banner?) {
        banner.visibility = if (shown == null) View.GONE else View.VISIBLE
        if (shown == null) return
        banner.text = shown.text
        banner.setTextColor(ui.color(if (shown.trouble) R.color.warning else R.color.muted))
        banner.setBackgroundColor(ui.color(if (shown.trouble) R.color.warning_tint else R.color.overlay))
        // A banner that is a button is a whole finger's height; one that only says something is no button at all
        // (setOnClickListener makes a view clickable even when handed null).
        val action: (() -> Unit)? = when {
            shown.signInAgain -> ::signOut
            shown.passkey != null -> { -> passkey(shown.passkey) }
            else -> null
        }
        banner.setOnClickListener(action?.let { run -> View.OnClickListener { run() } })
        banner.isClickable = action != null
        banner.minHeight = if (action != null) ui.dp(48) else 0
    }

    private fun showMenu(anchor: View) {
        PopupMenu(activity, anchor).apply {
            (snapshot.session as? SessionState.SignedIn)?.let { menu.add(it.content.email).isEnabled = false }
            // The screens the web draws, in the shared WebView, on the sandbox the board has open.
            for ((label, path) in WEB_SCREENS) {
                val title = activity.getString(label)
                menu.add(title).setOnMenuItemClickListener {
                    WebActivity.open(activity, WebActivity.onSandbox(path, snapshot.open), title)
                    true
                }
            }
            menu.add(activity.getString(R.string.shell_words_sign_out)).setOnMenuItemClickListener {
                signOut()
                true
            }
            show()
        }
    }

    private fun signOut() = Calls.send(Request.SignOut)

    // The core reconnects by itself once the ceremony went through; a closed sheet leaves the banner as it was.
    private var ceremony = false

    private fun passkey(asked: Passkey) {
        val sandbox = snapshot.open ?: return
        if (ceremony) {
            return
        }
        ceremony = true
        Passkeys(activity).run(sandbox, asked.register) { failed ->
            ceremony = false
            if (failed != null) {
                val sentence = activity.getString(if (asked.register) R.string.sandbox_sign_in_wall_passkey_not_added else R.string.sandbox_sign_in_wall_passkey_sign_in_incomplete)
                android.widget.Toast.makeText(activity, "$sentence $failed".trim(), android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        main.postDelayed(ticking, MINUTE)
    }

    override fun onDetachedFromWindow() {
        main.removeCallbacks(ticking)
        super.onDetachedFromWindow()
    }

    private companion object {
        const val MINUTE = 60_000L
        val WEB_SCREENS = listOf(
            R.string.shared_workspace to "/workspace",
            R.string.shared_sandbox_hub to "/sandbox",
            R.string.shared_settings to "/settings",
            R.string.shared_capabilities to "/capabilities",
            R.string.sandbox_words_devices_section to "/devices",
            R.string.shared_browsers to "/browsers",
        )
    }
}
