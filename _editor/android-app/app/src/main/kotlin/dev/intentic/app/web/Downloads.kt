package dev.intentic.app.web

import android.app.DownloadManager
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.URLUtil
import android.webkit.WebView
import android.widget.Toast
import dev.intentic.app.R
import java.io.File

/**
 * The page's downloads. An address the network serves goes to DownloadManager, with the page's cookies. The editor's
 * own downloads are mostly `blob:` URLs (bytes it fetched from the sandbox with its session), which no other process can
 * read: the page itself reads that blob back and posts it here, and it is saved to Downloads.
 */
internal class Downloads(private val view: WebView) : DownloadListener {
    override fun onDownloadStart(url: String, agent: String, disposition: String?, mime: String?, length: Long) {
        val name = URLUtil.guessFileName(url, disposition, mime)
        if (url.startsWith("blob:")) {
            fetchBlob(url, name, mime)
            return
        }
        val context = view.context
        val request = DownloadManager.Request(Uri.parse(url))
            .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url).orEmpty())
            .addRequestHeader("User-Agent", agent)
            .setMimeType(mime)
            .setTitle(name)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        // The shared Downloads folder from Android 10, where it needs no permission; before, the system's own download
        // cache, which its Downloads app still lists.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
        context.getSystemService(DownloadManager::class.java).enqueue(request)
    }

    // The page's own fetch of its blob, posted back through intenticNative as `{kind: "download", …}`: a message the
    // page's contract does not have, so only this script sends it, and Bridge hands it to [save].
    private fun fetchBlob(url: String, name: String, mime: String?) {
        val script = """
            (async () => {
                const blob = await (await fetch(${quoted(url)})).blob();
                const data = await new Promise((done) => { const r = new FileReader(); r.onload = () => done(r.result); r.readAsDataURL(blob); });
                window.intenticNative.postMessage(JSON.stringify({ kind: "download", name: ${quoted(name)}, mime: blob.type || ${quoted(mime.orEmpty())}, data }));
            })();
        """.trimIndent()
        view.evaluateJavascript(script, null)
    }

    private fun quoted(text: String) = kotlinx.serialization.json.JsonPrimitive(text).toString()

    companion object {
        /** Saves a downloaded blob ([dataUrl], `data:<mime>;base64,…`) to Downloads and says so. */
        fun save(context: Context, name: String, mime: String, dataUrl: String) {
            val bytes = try {
                Base64.decode(dataUrl.substringAfter(','), Base64.DEFAULT)
            } catch (error: IllegalArgumentException) {
                Log.w("WebHost", "a download that was not base64")
                return
            }
            val saved = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, mime.ifEmpty { "application/octet-stream" })
                }
                val resolver = context.contentResolver
                resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)?.let { uri ->
                    resolver.openOutputStream(uri)?.use { it.write(bytes) }
                } != null
            } else {
                // Before Android 10 the shared Downloads folder needs a storage permission; the app's own folder does not.
                val folder = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return
                File(folder, name).writeBytes(bytes)
                true
            }
            if (saved) Toast.makeText(context, "${context.getString(R.string.connect_local_model_lane_fact_downloaded)}: $name", Toast.LENGTH_SHORT).show()
        }
    }
}
