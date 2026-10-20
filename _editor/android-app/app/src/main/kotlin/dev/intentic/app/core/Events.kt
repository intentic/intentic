package dev.intentic.app.core

import android.util.Log
import java.util.concurrent.CopyOnWriteArraySet

/**
 * The core's events, decoded where they arrive and handed to every observer through [post]: the main thread's handler
 * in the app, a direct call in a test. A screen observes while it is shown and closes the handle when it is not.
 */
class Events(private val post: (Runnable) -> Unit) {
    private val observers = CopyOnWriteArraySet<(Event) -> Unit>()
    private val early = CopyOnWriteArraySet<(Event) -> Unit>()

    /**
     * Every event as it is decoded, on the core's event thread, before it is posted: for work that should start before
     * the main thread is free, as laying out a conversation's first screen of rows. Keep it short and thread-safe.
     */
    fun observeEarly(observer: (Event) -> Unit): AutoCloseable {
        early.add(observer)
        return AutoCloseable { early.remove(observer) }
    }

    fun observe(observer: (Event) -> Unit): AutoCloseable {
        observers.add(observer)
        return AutoCloseable { observers.remove(observer) }
    }

    fun deliver(eventJson: String) {
        val event = try {
            Wire.decodeEvent(eventJson)
        } catch (error: IllegalArgumentException) {
            // SerializationException is one. Both sides come from one build, so this is a bug in the bridge: logged and
            // dropped, not thrown back into the core's thread. Only the first line: kotlinx appends the JSON input, and
            // an event can carry the account's email.
            Log.e(TAG, "an event the app cannot read: ${error.message?.lineSequence()?.first()}")
            return
        }
        early.forEach { it(event) }
        post(Runnable { observers.forEach { it(event) } })
    }

    private companion object {
        const val TAG = "IntenticCore"
    }
}
