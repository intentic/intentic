package dev.intentic.device.platform

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import dev.intentic.device.tools.ClipboardPort
import dev.intentic.device.tools.ToolFailed
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Writes the clipboard. Android lets an app in the background write it but not read it back, so there is no read. */
class AndroidClipboard(private val context: Context) : ClipboardPort {
    override fun put(text: String) {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        var failure: Throwable? = null
        val done = CountDownLatch(1)
        // On the main thread, where ClipboardManager is at home.
        Handler(Looper.getMainLooper()).post {
            try {
                manager.setPrimaryClip(ClipData.newPlainText("Intentic agent", text))
            } catch (error: RuntimeException) {
                failure = error
            } finally {
                done.countDown()
            }
        }
        if (!done.await(5, TimeUnit.SECONDS)) {
            throw ToolFailed("The phone did not answer in time.")
        }
        failure?.let { throw ToolFailed("Android would not let the clipboard be set: ${it.message}") }
    }
}
