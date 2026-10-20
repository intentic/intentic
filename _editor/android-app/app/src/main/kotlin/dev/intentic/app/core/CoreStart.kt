package dev.intentic.app.core

/**
 * Work that waits for the core to start, run the moment it has, on the thread that started it (IntenticApp's
 * `core-start`), or at once on the caller's thread when it already has. A conversation opened on a cold start asks for
 * its rows here, at the core's first moment, rather than after its screen's first frame.
 */
object CoreStart {
    private val waiting = ArrayList<() -> Unit>()
    private var started = false

    fun started() {
        val now = synchronized(this) {
            started = true
            ArrayList(waiting).also { waiting.clear() }
        }
        now.forEach { it() }
    }

    fun then(work: () -> Unit) {
        val now = synchronized(this) {
            if (!started) waiting.add(work)
            started
        }
        if (now) work()
    }
}
