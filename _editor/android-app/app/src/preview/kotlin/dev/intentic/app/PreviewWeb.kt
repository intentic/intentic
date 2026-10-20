package dev.intentic.app

import android.app.Activity
import android.os.Bundle
import android.util.Log
import dev.intentic.app.web.WebActivity
import dev.intentic.app.web.WebHost

/**
 * Preview builds only. Opens a web screen in the shared WebView against another copy of the web editor, with no session
 * asked of the core, and logs every message its page posts under the tag `WebBridge`. With the demo (`_site/demo`,
 * which signs itself in) served from this computer and `adb reverse tcp:47148 tcp:47148`:
 * `adb shell am start -n dev.intentic.app.bench/dev.intentic.app.PreviewWeb --es web http://127.0.0.1:47148/demo --es path /workspace`.
 */
class PreviewWeb : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        intent.getStringExtra("web")?.let { WebHost.base = it }
        WebHost.sessionless = true
        WebHost.heard = { message -> Log.i("WebBridge", message) }
        WebActivity.open(this, intent.getStringExtra("path") ?: "/workspace", "")
        finish()
    }
}
