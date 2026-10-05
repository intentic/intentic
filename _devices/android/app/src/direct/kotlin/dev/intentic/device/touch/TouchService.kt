package dev.intentic.device.touch

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.view.accessibility.AccessibilityEvent
import dev.intentic.device.Graph

/**
 * The touch service, which the person switches on in Android's Accessibility settings and which lets the agent they
 * connected read the screen and tap, swipe and type in the apps they allowed. It holds no logic of its own: the tools
 * (TouchTools) decide what is allowed, and reach the screen through [instance] while this is bound. It listens to no
 * events and no key presses.
 */
class TouchService : AccessibilityService() {
    override fun onServiceConnected() {
        instance = this
        Graph.log.event("The touch service connected")
        Graph.changes.fire()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) = Unit

    override fun onInterrupt() = Unit

    override fun onUnbind(intent: Intent?): Boolean {
        release()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        release()
        super.onDestroy()
    }

    private fun release() {
        if (instance === this) {
            instance = null
            Graph.log.event("The touch service disconnected")
            Graph.changes.fire()
        }
    }

    companion object {
        /** The bound service, or null while the person has it off. */
        @Volatile
        var instance: TouchService? = null
            private set
    }
}
