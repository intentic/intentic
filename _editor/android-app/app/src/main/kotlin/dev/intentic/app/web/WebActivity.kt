package dev.intentic.app.web

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import dev.intentic.app.R
import dev.intentic.app.ui.Looks
import dev.intentic.app.ui.Ui
import dev.intentic.app.ui.fitKeyboard
import dev.intentic.app.ui.padForBars

/**
 * A screen the app does not draw: the shared WebView ([WebHost]) under a bar with the page's own title. Back steps back
 * inside the page while it has somewhere to go, and closes this screen when it has not. Several of these can be open at
 * once (a conversation opened from one, Changes opened from that): the WebView is in the one in front, and moves back
 * when an earlier one is shown again, to the route it last showed.
 */
class WebActivity : ComponentActivity() {
    private lateinit var ui: Ui
    private lateinit var title: TextView
    private lateinit var holder: FrameLayout
    private var madeIn = 0
    private var shown: String? = null
    private var named = ""
    private var chosen: ValueCallback<Array<Uri>>? = null

    private val picker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        chosen?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        chosen = null
    }

    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        Looks.apply(this, base.resources.configuration)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        madeIn = Looks.generation
        ui = Ui(this)
        shown = savedInstanceState?.getString(SHOWN) ?: intent.getStringExtra(PATH)
        named = savedInstanceState?.getString(NAMED) ?: intent.getStringExtra(TITLE).orEmpty()
        holder = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
            padForBars(top = false)
        }
        setContentView(FrameLayout(this).apply {
            fitKeyboard()
            setBackgroundColor(ui.color(R.color.canvas))
            addView(ui.column(bar(), holder))
        })
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = stepBack()
        })
        // A screen made again (a rotation, a new look) finds the page where it was; a new one sends it to its route.
        val page = attach()
        if (savedInstanceState == null) shown?.let(WebHost::show) else page.requestFocus()
    }

    override fun onResume() {
        super.onResume()
        Looks.refresh(this, madeIn)
        if (WebHost.screen !== this) {
            attach()
            shown?.let(WebHost::show)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(SHOWN, shown)
        outState.putString(NAMED, named)
    }

    override fun onDestroy() {
        chosen?.onReceiveValue(null)
        WebHost.detach(this)
        super.onDestroy()
    }

    /** The page moved: its title on the bar, and the route to come back to. */
    fun routed(path: String, title: String) {
        shown = path
        if (title.isNotEmpty()) {
            named = title
            this.title.text = title
        }
    }

    /** The page's file input: the system's picker, answered back to the page. */
    fun choose(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams) {
        chosen?.onReceiveValue(null)
        chosen = callback
        try {
            picker.launch(params.createIntent())
        } catch (error: ActivityNotFoundException) {
            chosen = null
            callback.onReceiveValue(null)
        }
    }

    private fun attach() = WebHost.attach(this).also { page ->
        holder.addView(page, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    }

    private fun stepBack() = WebHost.back { stepped -> if (!stepped) finish() }

    private fun bar(): LinearLayout {
        val back = ui.iconButton(R.drawable.ic_back, getString(R.string.ui_action_back)) { stepBack() }
        title = ui.barTitle(named).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = ui.dp(4) }
        }
        return ui.row(back, title).apply {
            setPadding(ui.dp(4), ui.dp(4), ui.dp(16), ui.dp(4))
            padForBars(bottom = false)
        }
    }

    companion object {
        private const val PATH = "path"
        private const val TITLE = "title"
        private const val SHOWN = "shown"
        private const val NAMED = "named"

        /** Shows the web's [path] (a route of the editor, `?sandbox=` choosing the sandbox) under [title] until it says its own. */
        fun open(context: Context, path: String, title: String = "") = context.startActivity(intent(context, path, title))

        fun intent(context: Context, path: String, title: String = ""): Intent =
            Intent(context, WebActivity::class.java).putExtra(PATH, path).putExtra(TITLE, title)

        /** [path] on [sandbox], the one the board has open, so the page shows the same sandbox the app does. */
        fun onSandbox(path: String, sandbox: String?): String =
            if (sandbox == null) path else "$path${if ('?' in path) '&' else '?'}sandbox=${Uri.encode(sandbox)}"
    }
}
