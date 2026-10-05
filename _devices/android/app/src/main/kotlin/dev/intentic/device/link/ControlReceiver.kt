package dev.intentic.device.link

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.intentic.device.Graph

/** The Pause, Resume and Stop sharing buttons of the app's own notifications. Not exported. */
class ControlReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_PAUSE -> Graph.settings.paused = true
            ACTION_RESUME -> Graph.settings.paused = false
            ACTION_STOP_SCREEN -> {
                Graph.log.event("The owner stopped screen sharing")
                Graph.screen.stop()
            }
        }
        Graph.changes.fire()
    }

    companion object {
        const val ACTION_PAUSE = "dev.intentic.device.PAUSE"
        const val ACTION_RESUME = "dev.intentic.device.RESUME"
        const val ACTION_STOP_SCREEN = "dev.intentic.device.STOP_SCREEN"
    }
}
