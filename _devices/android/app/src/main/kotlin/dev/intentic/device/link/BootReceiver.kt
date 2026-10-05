package dev.intentic.device.link

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.intentic.device.Graph
import dev.intentic.device.store.LinkMode

/** Starts the connection again after boot or an app update, for the owner who chose "Stay connected" and only for them. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Graph.pairings.get() != null && Graph.settings.mode == LinkMode.STAY) {
            ConnectionService.start(context)
        }
    }
}
