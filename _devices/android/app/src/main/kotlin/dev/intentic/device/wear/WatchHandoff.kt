package dev.intentic.device.wear

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.ContextCompat
import androidx.wear.remote.interactions.RemoteActivityHelper
import com.google.android.gms.wearable.Wearable
import dev.intentic.device.protocol.PhoneWire
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors

/**
 * The phone's half of pairing a watch, which has no camera to scan its card's code with. The phone scans it, and this
 * opens the pairing screen of Intentic Device on the watch with the same code, through Wear OS's own phone-to-watch link.
 * The phone never redeems the code: the watch shows the sandbox's address and asks the person there, as a phone does.
 */
object WatchHandoff {
    data class Watch(val id: String, val name: String)

    /** The watches connected to this phone right now, or why none can be listed. Answers on the main thread. */
    fun watches(context: Context, answer: (List<Watch>, String?) -> Unit) {
        try {
            Wearable.getNodeClient(context).connectedNodes
                .addOnSuccessListener { nodes -> answer(nodes.map { Watch(it.id, it.displayName) }, null) }
                .addOnFailureListener { error -> answer(emptyList(), unreachable(error)) }
        } catch (error: RuntimeException) {
            answer(emptyList(), unreachable(error))
        }
    }

    /** Opens the pairing screen on [watch] with [code]. [answer] gets null when it opened, or what went wrong. */
    fun send(context: Context, watch: Watch, code: String, answer: (String?) -> Unit) {
        val intent = Intent(Intent.ACTION_VIEW)
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .setData(Uri.parse(PhoneWire.pairHereLink(code)))
        val main = ContextCompat.getMainExecutor(context)
        try {
            val future = RemoteActivityHelper(context, Executors.newSingleThreadExecutor()).startRemoteActivity(intent, watch.id)
            future.addListener({
                val failure = try {
                    future.get()
                    null
                } catch (error: ExecutionException) {
                    "${watch.name} did not open it: install Intentic Device on the watch first (intentic.dev/watch). ${error.cause?.message.orEmpty()}".trim()
                } catch (error: InterruptedException) {
                    "Sending to ${watch.name} was interrupted."
                }
                answer(failure)
            }, main)
        } catch (error: RuntimeException) {
            answer(unreachable(error))
        }
    }

    private fun unreachable(error: Exception): String =
        "This phone cannot reach a watch: it needs the Wear OS app and Google Play services. (${error.message ?: error.javaClass.simpleName})"
}
