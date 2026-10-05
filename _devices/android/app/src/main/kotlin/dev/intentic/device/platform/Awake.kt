package dev.intentic.device.platform

import android.content.Context
import android.os.PowerManager

/**
 * A short partial wake lock, so a request that arrives while the screen is off is answered before the CPU sleeps again.
 * Taken for the length of one connect or one call, never held open: the foreground service keeps the process alive, not awake.
 */
class Awake(context: Context) {
    private val lock = (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "intentic:agent")
        .apply { setReferenceCounted(false) }

    /** Keeps the CPU awake for [ms] from now; a second call restarts the clock. */
    fun hold(ms: Long) {
        lock.acquire(ms)
    }
}
