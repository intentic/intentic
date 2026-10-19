package dev.intentic.spike

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * The baseline: today's web editor (the production build of `_site/demo`) in a WebView, opened on the long chat. The
 * bench serves the build with a script ahead of the app's own (`bench/inject.ts`) that inflates the chat, streams the
 * turn and calls [Bridge] when rows are drawn, so this arm logs the same lines the native ones do. The Android app
 * today is a Trusted Web Activity, which is Chrome; a WebView is the same engine inside this process.
 */
class WebConversationActivity : Activity() {
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val launch = Launch.from(intent)
        val origin = intent.getStringExtra("origin") ?: "http://127.0.0.1:8790"
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.addJavascriptInterface(Bridge(launch.rows), "SpikeBridge")
        // A WebView draws its page under its own padding, so the bars are kept clear by the frame around it.
        val frame = FrameLayout(this)
        frame.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        ViewCompat.setOnApplyWindowInsetsListener(frame) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(frame)
        val query = "mode=default&spikeRows=${launch.rows}&spikeStream=${if (launch.stream) 1 else 0}" +
            "&spikeStreamMs=${launch.streamMs}&spikeDelayMs=${launch.streamDelayMs}"
        web.loadUrl("$origin/demo/agents/$CONVERSATION?$query")
    }

    private inner class Bridge(private val rows: Int) {
        @JavascriptInterface
        fun ready(drawn: Int) {
            runOnUiThread {
                reportFullyDrawn()
                val ms = SystemClock.uptimeMillis() - Process.getStartUptimeMillis()
                Log.i(TAG, "SPIKE_READY arm=web rows=$rows ms=$ms drawn=$drawn")
            }
        }

        @JavascriptInterface
        fun streamDone(drawn: Int) {
            Log.i(TAG, "SPIKE_STREAM_DONE arm=web rows=$rows drawn=$drawn")
        }
    }

    private companion object {
        const val TAG = "Spike"
        const val CONVERSATION = "cnv_soft_deletes"
    }
}
