package dev.intentic.app.state

import dev.intentic.app.core.Event
import java.util.concurrent.CopyOnWriteArraySet

/**
 * The app's one copy of the core's state, on the main thread. It listens from before the core starts, so the state the
 * core says once at boot (the kept session, sandboxes and board) is here for a screen that opens later: a screen
 * watches it and is told the current snapshot at once, then every change.
 */
object AppState {
    var snapshot = Snapshot()
        private set

    private val watchers = CopyOnWriteArraySet<(Snapshot) -> Unit>()

    fun apply(event: Event) = replace(snapshot.with(event))

    fun failed(why: String) = replace(snapshot.copy(failure = why))

    fun watch(watcher: (Snapshot) -> Unit): AutoCloseable {
        watchers.add(watcher)
        watcher(snapshot)
        return AutoCloseable { watchers.remove(watcher) }
    }

    private fun replace(next: Snapshot) {
        if (next != snapshot) {
            snapshot = next
            watchers.forEach { it(next) }
        }
    }
}
