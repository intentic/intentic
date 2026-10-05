package dev.intentic.device.touch

import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger

/** What puts a question in front of the person: a heads-up notification with Allow and Deny in the app. */
interface PromptSink {
    fun show(id: Int, title: String, text: String)

    fun dismiss(id: Int)
}

enum class Answer { ALLOWED, DENIED, NO_ANSWER, PAUSED }

/**
 * Asks the person, on the phone, before an act the confirm rules flag, and waits for their tap. Silence is a no: after
 * [timeoutMs] without an answer the act does not happen, and neither does it if the person pauses the agent meanwhile. An
 * answer arrives from the notification's own buttons ([answer]).
 */
class Confirmations(
    private val sink: PromptSink,
    private val paused: () -> Boolean,
    private val timeoutMs: Long = TIMEOUT_MS,
    private val pollMs: Long = 200,
) {
    private val waiting = ConcurrentHashMap<Int, CompletableFuture<Boolean>>()
    private val ids = AtomicInteger(BASE_ID)

    fun ask(title: String, text: String): Answer {
        val id = ids.getAndIncrement().let { BASE_ID + Math.floorMod(it - BASE_ID, ID_SPAN) }
        val future = CompletableFuture<Boolean>()
        waiting[id] = future
        try {
            sink.show(id, title, text)
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
            while (true) {
                if (paused()) {
                    return Answer.PAUSED
                }
                val left = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
                if (left <= 0) {
                    return Answer.NO_ANSWER
                }
                try {
                    return if (future.get(minOf(pollMs, left), TimeUnit.MILLISECONDS)) Answer.ALLOWED else Answer.DENIED
                } catch (ignored: TimeoutException) {
                    // Not yet: look at the pause and the clock again.
                }
            }
        } finally {
            waiting.remove(id)
            sink.dismiss(id)
        }
    }

    /** The person's tap. False when nothing was waiting on [id] (it timed out, or the notification is an old one). */
    fun answer(id: Int, allow: Boolean): Boolean = waiting[id]?.complete(allow) ?: false

    companion object {
        const val TIMEOUT_MS = 60_000L
        const val BASE_ID = 1000
        private const val ID_SPAN = 90
    }
}
