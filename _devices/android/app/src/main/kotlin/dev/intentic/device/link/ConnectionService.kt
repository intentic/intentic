package dev.intentic.device.link

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat
import dev.intentic.device.Graph
import dev.intentic.device.platform.Notifier
import dev.intentic.device.store.LinkMode
import java.net.URI

/**
 * Holds the connection to the sandbox in the foreground, which is what keeps Android from ending the process and what
 * puts the persistent "Your agent is connected" notification, with its Pause button, on the screen. The socket itself
 * belongs to [LinkController]; this service is its reason to exist and its notice.
 *
 * Declared with foreground service type `specialUse` and its subtype property: no other type describes an agent
 * the owner connected to their own phone.
 */
class ConnectionService : Service() {
    private val observer: () -> Unit = { refresh() }

    override fun onCreate() {
        super.onCreate()
        running = true
        Graph.changes.add(observer)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // The notification first: Android gives a service started for the foreground a few seconds to show one.
        showNotice(first = true)
        Graph.link.wake()
        return if (Graph.settings.mode == LinkMode.STAY) START_STICKY else START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        running = false
        Graph.changes.remove(observer)
        super.onDestroy()
    }

    private fun refresh() {
        showNotice(first = false)
    }

    private fun showNotice(first: Boolean) {
        val sandbox = Graph.pairings.get()?.sandboxUrl?.let { runCatching { URI(it).host }.getOrNull() }
        val notification = Graph.notifier.link(Graph.link.state, Graph.settings.paused, sandbox)
        if (first) {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(Notifier.ID_LINK, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                // Before Android 14 the manifest's type is used; `specialUse` itself is not a type those releases know.
                startForeground(Notifier.ID_LINK, notification)
            }
        } else {
            (getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager).notify(Notifier.ID_LINK, notification)
        }
    }

    companion object {
        /** Whether the service is up now, so the controller does not ask Android to start it again at every dial. */
        @Volatile
        var running = false
            private set

        private var lastRefusalLogged = 0L

        /** Starts the service from somewhere Android allows it (the app open, a push, boot). False when Android refused. */
        fun start(context: Context): Boolean =
            try {
                ContextCompat.startForegroundService(context, Intent(context, ConnectionService::class.java))
                true
            } catch (error: RuntimeException) {
                // ForegroundServiceStartNotAllowedException (Android 12+) is a RuntimeException: the app was in the background.
                // Said once in a while, not at every retry of a link that cannot start.
                val now = System.currentTimeMillis()
                if (now - lastRefusalLogged > 10 * 60_000L) {
                    lastRefusalLogged = now
                    Graph.log.event("Android would not let the app start its connection from the background.")
                }
                false
            }

        fun stop(context: Context) {
            context.stopService(Intent(context, ConnectionService::class.java))
        }
    }
}
