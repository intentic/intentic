package dev.intentic.device.link

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.intentic.device.Graph

/**
 * A data message `{"kind":"wake"}` from the sandbox's push relay means "dial in, a call is waiting". It carries no
 * content and shows nothing. A high-priority push is one of the few things Android lets start a foreground service
 * from the background, which is why the connection can begin without the app being open.
 */
@Suppress("OVERRIDE_DEPRECATION")
class WakeMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Graph.settings.fcmToken = token
        Graph.changes.fire()
    }

    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data["kind"] == "wake" && Graph.pairings.get() != null) {
            Graph.log.event("The sandbox woke the phone")
            Graph.awake.hold(30_000)
            ConnectionService.start(this)
        }
    }
}
