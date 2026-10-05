package dev.intentic.device.platform

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import dev.intentic.device.R
import dev.intentic.device.link.ControlReceiver
import dev.intentic.device.link.LinkState
import dev.intentic.device.store.AccessRequest
import dev.intentic.device.store.AppMode
import dev.intentic.device.ui.MainActivity
import java.util.concurrent.atomic.AtomicInteger

/**
 * Every notification the app posts. Three kinds matter to the owner's consent: the persistent one while the agent is
 * connected (with a Pause action), the one that asks to share the screen, and the ones that ask to open something or
 * to allow an app. Each of the asking ones is the only way its action happens: Android does not let a background
 * service start an activity, and nothing is shared, opened or allowed until the owner taps.
 */
class Notifier(private val context: Context) {
    private val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    private val openCounter = AtomicInteger(0)

    fun createChannels() {
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_LINK, "Connection to your agent", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown for as long as your agent is connected to this phone, with a button to pause it."
                setShowBadge(false)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ASKS, "Requests from your agent", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "When your agent asks to see the screen, open something or use an app. Nothing happens until you tap."
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_SCREEN, "Screen sharing", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while your agent can see your screen."
                setShowBadge(false)
            },
        )
    }

    /**
     * Whether the person can see the persistent "connected" notice: notifications are allowed for the app (Android 13 asks)
     * and its channel is not switched off. The agent is refused while this is false, so it is never connected unseen.
     */
    fun noticeVisible(): Boolean {
        if (!manager.areNotificationsEnabled()) {
            return false
        }
        val channel = manager.getNotificationChannel(CHANNEL_LINK)
        return channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
    }

    fun link(state: LinkState, paused: Boolean, sandbox: String?): Notification {
        val title = when {
            paused -> "Your agent is paused"
            state == LinkState.CONNECTED -> "Your agent is connected"
            state == LinkState.WAITING -> "Waiting for your sandbox"
            else -> "Connecting your agent"
        }
        val text = when {
            paused -> "Every request is refused until you resume."
            sandbox != null -> "Sandbox: $sandbox. Tap to see what it did."
            else -> "Tap to open Intentic Device."
        }
        val builder = NotificationCompat.Builder(context, CHANNEL_LINK)
            .setSmallIcon(R.drawable.ic_stat_agent)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openApp())
        if (paused) {
            // Resuming hands the agent the phone again, so it takes an unlocked phone; pausing never does.
            builder.addAction(NotificationCompat.Action.Builder(0, "Resume", control(ControlReceiver.ACTION_RESUME)).setAuthenticationRequired(true).build())
        } else {
            builder.addAction(NotificationCompat.Action.Builder(0, "Pause", control(ControlReceiver.ACTION_PAUSE)).build())
        }
        return builder.build()
    }

    fun screenSharing(): Notification =
        NotificationCompat.Builder(context, CHANNEL_SCREEN)
            .setSmallIcon(R.drawable.ic_stat_agent)
            .setContentTitle("Your agent can see your screen")
            .setContentText("Screenshots only, when it asks. Stop sharing any time.")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openApp())
            .addAction(0, "Stop sharing", control(ControlReceiver.ACTION_STOP_SCREEN))
            .build()

    /** "Your agent asks to see the screen": the tap opens the activity that shows Android's own consent dialog. */
    fun askToShareScreen() {
        val tap = PendingIntent.getActivity(
            context, 0,
            Intent(context, ScreenConsentActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        manager.notify(
            ID_SCREEN_ASK,
            ask("Your agent asks to see the screen", "Tap to choose what Android shares. Nothing is shared until you do.")
                .setContentIntent(tap).setTimeoutAfter(FIVE_MINUTES).build(),
        )
    }

    /** "Your agent wants to open <x>": the tap starts [what], which only a tap on a notification may do from the background. */
    fun askToOpen(label: String, what: Intent) {
        val code = openCounter.getAndIncrement() % MAX_OPEN
        val tap = PendingIntent.getActivity(context, ID_OPEN + code, what.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        manager.notify(
            ID_OPEN + code,
            ask("Your agent wants to open $label", "Tap to open it. It does not open until you do.").setContentIntent(tap).setTimeoutAfter(TEN_MINUTES).build(),
        )
    }

    /** Allow and Deny for an app the agent asked to use; neither happens without the owner's tap, on an unlocked phone. */
    fun askAccess(request: AccessRequest) {
        val verb = if (request.mode == AppMode.READ) "read" else "act in"
        val builder = ask("Your agent asks to $verb ${request.label}", request.reason.ifBlank { "No reason given." })
            .setStyle(NotificationCompat.BigTextStyle().bigText(request.reason.ifBlank { "No reason given." }))
            .setContentIntent(openApp())
            .setTimeoutAfter(DAY)
            .addAction(NotificationCompat.Action.Builder(0, "Allow", accessIntent(AccessReceiver.ACTION_ALLOW, request)).setAuthenticationRequired(true).build())
            .addAction(NotificationCompat.Action.Builder(0, "Deny", accessIntent(AccessReceiver.ACTION_DENY, request)).build())
        manager.notify(accessId(request.pkg, request.mode), builder.build())
    }

    /**
     * A question for the person with Allow and Deny, shown heads-up. [allow] and [deny] are explicit broadcasts to whoever
     * handles the answer; Allow takes an unlocked phone. No answer within [timeoutMs] and the notification goes away.
     */
    fun prompt(id: Int, title: String, text: String, allow: Intent, deny: Intent, timeoutMs: Long) {
        fun broadcast(code: Int, intent: Intent): PendingIntent = PendingIntent.getBroadcast(context, code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        manager.notify(
            id,
            ask(title, text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(openApp())
                .setTimeoutAfter(timeoutMs)
                .addAction(NotificationCompat.Action.Builder(0, "Allow", broadcast(id * 2, allow)).setAuthenticationRequired(true).build())
                .addAction(NotificationCompat.Action.Builder(0, "Deny", broadcast(id * 2 + 1, deny)).build())
                .build(),
        )
    }

    fun cancel(id: Int) {
        manager.cancel(id)
    }

    fun cancelAccess(pkg: String, mode: AppMode) {
        manager.cancel(accessId(pkg, mode))
    }

    fun cancelAsks() {
        manager.cancel(ID_SCREEN_ASK)
        for (index in 0 until MAX_OPEN) {
            manager.cancel(ID_OPEN + index)
        }
    }

    private fun ask(title: String, text: String): NotificationCompat.Builder =
        NotificationCompat.Builder(context, CHANNEL_ASKS)
            .setSmallIcon(R.drawable.ic_stat_agent)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)

    private fun openApp(): PendingIntent =
        PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)

    private fun control(action: String): PendingIntent =
        PendingIntent.getBroadcast(context, 0, Intent(context, ControlReceiver::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE)

    // The data URI makes each app's Allow and Deny a different PendingIntent: Intent equality ignores extras.
    private fun accessIntent(action: String, request: AccessRequest): PendingIntent {
        val intent = Intent(context, AccessReceiver::class.java).setAction(action)
            .setData(Uri.parse("intentic-access://$action/${request.pkg}/${request.mode.key}"))
            .putExtra(AccessReceiver.EXTRA_PACKAGE, request.pkg)
            .putExtra(AccessReceiver.EXTRA_MODE, request.mode.key)
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun accessId(pkg: String, mode: AppMode): Int = ID_ACCESS + Math.floorMod("$pkg/${mode.key}".hashCode(), MAX_ACCESS)

    companion object {
        const val CHANNEL_LINK = "link"
        const val CHANNEL_ASKS = "asks"
        const val CHANNEL_SCREEN = "screen"
        const val ID_LINK = 1
        const val ID_SCREEN = 2
        const val ID_SCREEN_ASK = 4
        private const val ID_OPEN = 100
        private const val MAX_OPEN = 50
        private const val ID_ACCESS = 200
        private const val MAX_ACCESS = 100
        private const val FIVE_MINUTES = 5 * 60_000L
        private const val TEN_MINUTES = 10 * 60_000L
        private const val DAY = 24 * 60 * 60_000L
    }
}
