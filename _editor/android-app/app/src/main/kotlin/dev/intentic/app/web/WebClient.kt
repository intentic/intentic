package dev.intentic.app.web

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.util.Log
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.browser.customtabs.CustomTabsIntent

/**
 * Keeps the WebView on the web editor: its own origin loads here, any other http(s) page opens in a Custom Tab, and any
 * other scheme goes to whichever app handles it. Frames inside the page (the sandbox's apps under Browsers) are theirs
 * to navigate.
 */
internal class WebClient(private val origin: String) : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (!request.isForMainFrame) return false
        val url = request.url
        if ("${url.scheme}://${url.authority}" == origin) return false
        val context = WebHost.screen ?: return true
        try {
            if (url.scheme == "http" || url.scheme == "https") {
                CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, url)
            } else {
                context.startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
            }
        } catch (error: ActivityNotFoundException) {
            Log.w("WebHost", "nothing opens ${url.scheme} links")
        }
        return true
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        WebHost.reloading()
    }

    // The page's renderer died (out of memory, or killed): a WebView whose renderer is gone cannot be used again, so it
    // is let go and made afresh by the next screen that asks for one.
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        Log.w("WebHost", "the page's renderer is gone (crashed: ${detail.didCrash()})")
        (view.parent as? android.view.ViewGroup)?.removeView(view)
        view.destroy()
        WebHost.gone()
        WebHost.screen?.finish()
        return true
    }
}

/** The page's file inputs, answered by the system's picker through the screen showing the page. */
internal class WebChrome : WebChromeClient() {
    override fun onShowFileChooser(view: WebView, chosen: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
        val screen = WebHost.screen
        if (screen == null) {
            chosen.onReceiveValue(null)
            return true
        }
        screen.choose(chosen, params)
        return true
    }
}
