package dev.intentic.device.platform

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.intentic.device.Graph
import dev.intentic.device.store.AllowedApp
import dev.intentic.device.store.AppMode

/**
 * The owner's answer to an `ask_access` notification. Not exported: only the system, delivering a tap on the
 * notification's own button, can reach it. It acts only on a request that is really waiting, so a replayed or invented
 * intent grants nothing, and "Allow" is the one place an app is ever added to the allow-list without the app's own screen.
 */
class AccessReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pkg = intent.getStringExtra(EXTRA_PACKAGE) ?: return
        val mode = AppMode.of(intent.getStringExtra(EXTRA_MODE)) ?: return
        val request = Graph.requests.find(pkg, mode) ?: return
        Graph.requests.remove(pkg, mode)
        Graph.notifier.cancelAccess(pkg, mode)
        val verb = if (mode == AppMode.READ) "read" else "act in"
        when (intent.action) {
            ACTION_ALLOW -> {
                // Looked up again so the label is the phone's own, not the agent's.
                val label = Graph.apps.find(pkg)?.label ?: request.label
                Graph.allowList.put(AllowedApp(pkg, label, mode, sensitive = false))
                Graph.log.event("The owner allowed the agent to $verb $label")
            }
            ACTION_DENY -> {
                Graph.requests.deny(pkg, mode)
                Graph.log.event("The owner said no to the agent asking to $verb ${request.label}")
            }
        }
        Graph.changes.fire()
    }

    companion object {
        const val ACTION_ALLOW = "dev.intentic.device.ACCESS_ALLOW"
        const val ACTION_DENY = "dev.intentic.device.ACCESS_DENY"
        const val EXTRA_PACKAGE = "package"
        const val EXTRA_MODE = "mode"
    }
}
