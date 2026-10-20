package dev.intentic.app.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.intentic.app.BuildConfig
import dev.intentic.app.R
import dev.intentic.app.core.Calls
import dev.intentic.app.core.CoreStart
import dev.intentic.app.core.Outcome
import dev.intentic.app.core.Request
import dev.intentic.app.core.RequestNotificationInner
import dev.intentic.app.ui.MainActivity
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The relay's data-only `{kind: "notify", tag, url, sandbox, requireInteraction?, silent?}`: no words ride through
 * Google. The core fetches them from the sandbox over the person's own session (`GET /push/notification`), and the
 * notification is drawn here under the message's tag, so a newer one under the same tag replaces it. When the sandbox
 * no longer has the words (or cannot be reached), generic ones stand in: a high-priority message must show something.
 */
class NotifyService : FirebaseMessagingService() {
    override fun onNewToken(token: String) = PushSupport.tokenIs(token)

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data["kind"] != "notify") {
            return
        }
        val tag = data["tag"] ?: "intentic"
        val sandbox = data["sandbox"].orEmpty()
        val waiting = data["requireInteraction"] == "true"
        val silent = data["silent"] == "true"
        // Runs on Firebase's worker thread, which may wait: this is the window Android gives a message to be handled.
        val done = CountDownLatch(1)
        var words: Outcome? = null
        CoreStart.then {
            Calls.send(Request.Notification(RequestNotificationInner(sandbox = sandbox, tag = tag))) { outcome ->
                words = outcome
                done.countDown()
            }
        }
        done.await(8, TimeUnit.SECONDS)
        val said = (words as? Outcome.Notification)?.content
        show(
            tag = tag,
            title = said?.title ?: getString(R.string.app_name),
            body = said?.body ?: if (waiting) "An agent is waiting for you." else "An agent has news for you.",
            url = said?.url ?: data["url"],
            sandbox = sandbox,
            waiting = waiting || said?.requireInteraction == true,
            silent = silent || said?.silent == true,
        )
    }

    private fun show(tag: String, title: String, body: String, url: String?, sandbox: String, waiting: Boolean, silent: Boolean) {
        val manager = NotificationManagerCompat.from(this)
        if (!manager.areNotificationsEnabled()) {
            return
        }
        val channel = if (waiting) WAITING else NEWS
        channels(this)
        val notification = NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setSilent(silent)
            .setOngoing(false)
            .setPriority(if (waiting) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(opening(url, sandbox, tag))
            .build()
        try {
            manager.notify(tag, 0, notification)
        } catch (denied: SecurityException) {
            // POST_NOTIFICATIONS not granted (Android 13+): nothing to show.
        }
    }

    /** The in-app path as the web link the app already routes: a conversation opens natively, the rest on the web. */
    private fun opening(url: String?, sandbox: String, tag: String): PendingIntent {
        val conversation = url?.let { Uri.parse("${BuildConfig.WEB_URL}$it").getQueryParameter("conversation") }
        val link = when {
            conversation != null -> "${BuildConfig.WEB_URL}/agents/${Uri.encode(conversation)}?sandbox=${Uri.encode(sandbox)}"
            else -> null
        }
        val intent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            link?.let { data = Uri.parse(it) }
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        return PendingIntent.getActivity(this, tag.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    companion object {
        private const val WAITING = "waiting"
        private const val NEWS = "news"

        fun channels(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            manager.createNotificationChannel(NotificationChannel(WAITING, "Agents waiting for you", NotificationManager.IMPORTANCE_HIGH))
            manager.createNotificationChannel(NotificationChannel(NEWS, "Agent updates", NotificationManager.IMPORTANCE_DEFAULT))
        }
    }
}
