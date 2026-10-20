package dev.intentic.app.web

import android.annotation.SuppressLint
import android.content.Context
import android.content.MutableContextWrapper
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.intentic.app.BuildConfig
import dev.intentic.app.R
import dev.intentic.app.core.Calls
import dev.intentic.app.core.Outcome
import dev.intentic.app.core.OutcomeWebSessionInner
import dev.intentic.app.core.Request
import dev.intentic.app.core.RequestWebSessionInner
import dev.intentic.app.core.WebDaemonSession
import dev.intentic.app.ui.Looks
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The one WebView every screen the app does not draw shares (`_editor/web`, `app/environments/nativeApp.ts`). It is made
 * once, after the board's first frame, and moved into whichever [WebActivity] shows it; its page is loaded once and
 * then moved between routes with `intenticEmbed.open` (`router/nativeHandoff.ts`), so a second web screen opens without
 * a reload.
 *
 * The page signs in with what the core holds: the platform cookie, set before the first load, and a daemon session per
 * sandbox, handed over with `intenticEmbed.adoptSession` before a route on a sandbox it has not signed into (a Google
 * account would otherwise meet a Google sign-in the WebView cannot show).
 */
@SuppressLint("StaticFieldLeak") // Holds the application context between screens, never an activity.
object WebHost {
    private const val TAG = "WebHost"
    private val main = Handler(Looper.getMainLooper())
    private var view: WebView? = null
    private var wrapper: MutableContextWrapper? = null
    private var loaded = false
    private var ready = false
    private val whenReady = ArrayList<() -> Unit>()
    private val adopted = HashSet<String>()

    /** Where the web editor is. A preview build points it at a local demo. */
    var base: String = BuildConfig.WEB_URL

    /** A preview build's demo page signs itself in: no session is asked of the core. */
    var sessionless = false

    /** Set by a preview build, to see every message the page posts. */
    var heard: ((String) -> Unit)? = null

    /** The screen showing the page, which hears its title and answers its file chooser. */
    var screen: WebActivity? = null
        private set

    private val origin: String get() = Uri.parse(base).let { "${it.scheme}://${it.authority}" }

    /** Makes the WebView ahead of the first web screen and, when someone is signed in, loads the page into it. */
    fun warm(context: Context, path: String) {
        if (view != null) return
        view = make(context.applicationContext)
        load(path)
    }

    fun attach(activity: WebActivity): WebView {
        val page = view ?: make(activity.applicationContext).also { view = it }
        wrapper?.baseContext = activity
        (page.parent as? ViewGroup)?.removeView(page)
        screen = activity
        return page
    }

    fun detach(activity: WebActivity) {
        if (screen !== activity) return
        (view?.parent as? ViewGroup)?.removeView(view)
        wrapper?.baseContext = activity.applicationContext
        screen = null
    }

    /** Shows [path]: the first load, or a move inside the page once it is up. */
    fun show(path: String) {
        if (!loaded) {
            load(path)
            return
        }
        whenUp {
            adopt(sandboxOf(path)) {
                // False for a screen the app draws (or a path the page refuses): the app shows it itself, as it would
                // had the page handed it over.
                run("window.intenticEmbed.open(${quoted(path)})") { answer ->
                    if (answer != "true") Bridge.open(path)
                }
            }
        }
    }

    /** One step back inside the page; false when there is none, and the screen showing it should close. */
    fun back(answer: (Boolean) -> Unit) {
        if (!ready) return answer(false)
        run("window.intenticEmbed ? window.intenticEmbed.back() : false") { answer(it == "true") }
    }

    /** Signed out: the page must not keep the last person, in its cookies or its storage. */
    fun forget() {
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        WebStorage.getInstance().deleteAllData()
        view?.apply {
            clearHistory()
            loadUrl("about:blank")
        }
        loaded = false
        ready = false
        whenReady.clear()
        adopted.clear()
    }

    private fun load(path: String) {
        val page = view ?: return
        loaded = true
        ready = false
        session(null) {
            val joiner = if ('?' in path) '&' else '?'
            page.loadUrl("${base.trimEnd('/')}$path${joiner}embed=native&look=${Looks.name}")
        }
    }

    // The core's sessions for the page: the platform cookie (set before any load reads it) and, for [sandbox] or the
    // open one, the daemon's, adopted once the page is up.
    private fun session(sandbox: String?, then: () -> Unit) {
        if (sessionless) return then()
        Calls.send(Request.WebSession(RequestWebSessionInner(sandbox))) { outcome ->
            val session = (outcome as? Outcome.WebSession)?.content
            if (session == null) {
                Log.w(TAG, "no web session: ${(outcome as? Outcome.Failed)?.content?.message}")
            } else {
                keep(session)
            }
            then()
        }
    }

    private fun keep(session: OutcomeWebSessionInner) {
        val cookies = CookieManager.getInstance()
        cookies.setCookie(session.apiUrl, "${session.cookie}; Secure; HttpOnly; SameSite=Lax; Path=/")
        cookies.flush()
        session.daemon?.let { daemon -> whenUp { hand(daemon) } }
    }

    // Before a route on a sandbox the page has not signed into, its daemon session from the core.
    private fun adopt(sandbox: String?, then: () -> Unit) {
        if (sandbox == null || sandbox in adopted || sessionless) return then()
        Calls.send(Request.WebSession(RequestWebSessionInner(sandbox))) { outcome ->
            (outcome as? Outcome.WebSession)?.content?.daemon?.let(::hand)
            then()
        }
    }

    private fun hand(daemon: WebDaemonSession) {
        val session = buildJsonObject {
            put("token", daemon.token)
            put("expiresAt", daemon.expiresAt.toLong())
            put("email", daemon.email)
        }
        run("window.intenticEmbed.adoptSession(${quoted(daemon.sandbox)}, $session)") { answer ->
            if (answer == "true") adopted.add(daemon.sandbox)
        }
    }

    private fun whenUp(work: () -> Unit) {
        if (ready) work() else whenReady.add(work)
    }

    /** The page's first `routed`: its router, and `intenticEmbed` with it, is up. */
    internal fun up() {
        if (ready) return
        ready = true
        val waiting = whenReady.toList()
        whenReady.clear()
        waiting.forEach { it() }
    }

    /** A main-frame load began again (a reload): the page is not up until it routes. */
    internal fun reloading() {
        ready = false
    }

    internal fun gone() {
        view = null
        loaded = false
        ready = false
        adopted.clear()
    }

    private fun run(script: String, answer: (String?) -> Unit) {
        view?.evaluateJavascript(script, answer) ?: answer(null)
    }

    private fun quoted(text: String): String = Json.encodeToString(JsonPrimitive.serializer(), JsonPrimitive(text))

    private fun sandboxOf(path: String): String? = Uri.parse(path).getQueryParameter("sandbox")

    @SuppressLint("SetJavaScriptEnabled")
    private fun make(app: Context): WebView {
        val wrap = MutableContextWrapper(app)
        wrapper = wrap
        return WebView(wrap).apply {
            with(settings) {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
                userAgentString = "$userAgentString IntenticApp/${BuildConfig.VERSION_NAME}"
            }
            // The page wears the app's look itself; the WebView must not darken it a second time.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
                WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, false)
            }
            setBackgroundColor(app.getColor(R.color.canvas))
            webViewClient = WebClient(origin)
            webChromeClient = WebChrome()
            setDownloadListener(Downloads(this))
            // Injected only into frames of the web editor's own origin, unlike addJavascriptInterface, which every frame
            // would see, the sandbox's own apps under Browsers included.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.addWebMessageListener(this, "intenticNative", setOf(origin)) { _, message, _, mainFrame, _ ->
                    val data = message.data
                    if (mainFrame && data != null) main.post { Bridge.heard(data) }
                }
            } else {
                Log.w(TAG, "this WebView cannot take web messages: the page will run as a browser would")
            }
        }
    }
}
