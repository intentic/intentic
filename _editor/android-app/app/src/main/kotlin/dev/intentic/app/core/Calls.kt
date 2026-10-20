package dev.intentic.app.core

import android.os.Handler
import android.os.Looper

/**
 * Requests whose answer a screen waits for: [send] numbers the call through [Core.send] and runs `answered` with its
 * outcome, on the main thread, when the core's Reply arrives. It may be called from any thread: a screen opening a
 * conversation sends the moment the core has started, from the thread that started it. Numbering and filing happen
 * under one lock that the reply's delivery takes too, so a reply can never arrive before its callback is filed.
 */
object Calls {
    private val waiting = HashMap<Int, (Outcome) -> Unit>()
    private val main = Handler(Looper.getMainLooper())

    fun send(request: Request, answered: (Outcome) -> Unit = {}) {
        synchronized(waiting) {
            try {
                waiting[Core.send(request)] = answered
                return
            } catch (error: IllegalStateException) {
                // The core is not running: answered as the core would answer a failed call, on the main thread.
                main.post { answered(Outcome.Failed(OutcomeFailedInner(error.message ?: "the core is not running"))) }
            }
        }
    }

    /** On the main thread, with each event. */
    fun answer(event: Event) {
        if (event is Event.Reply) {
            synchronized(waiting) { waiting.remove(event.content.id) }?.invoke(event.content.outcome)
        }
    }
}
