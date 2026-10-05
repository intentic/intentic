package dev.intentic.device.touch

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

class ConfirmationsTest {
    private class Sink : PromptSink {
        val shown = CopyOnWriteArrayList<Triple<Int, String, String>>()
        val dismissed = CopyOnWriteArrayList<Int>()
        override fun show(id: Int, title: String, text: String) {
            shown += Triple(id, title, text)
        }

        override fun dismiss(id: Int) {
            dismissed += id
        }
    }

    private fun answerLater(confirmations: Confirmations, sink: Sink, allow: Boolean) =
        Thread {
            while (sink.shown.isEmpty()) Thread.sleep(5)
            Thread.sleep(20)
            confirmations.answer(sink.shown.first().first, allow)
        }.also { it.start() }

    @Test
    fun `an Allow tap is a yes, a Deny tap is a no, and the question is taken down either way`() {
        for ((tap, expected) in listOf(true to Answer.ALLOWED, false to Answer.DENIED)) {
            val sink = Sink()
            val confirmations = Confirmations(sink, paused = { false }, timeoutMs = 2_000, pollMs = 10)
            answerLater(confirmations, sink, tap)
            assertEquals(expected, confirmations.ask("Your agent wants to tap \"Pay\"", "In Bank."))
            assertEquals(sink.shown.map { it.first }, sink.dismissed.toList())
            assertEquals("Your agent wants to tap \"Pay\"", sink.shown.single().second)
        }
    }

    @Test
    fun `no answer is a no after the timeout`() {
        val sink = Sink()
        val confirmations = Confirmations(sink, paused = { false }, timeoutMs = 120, pollMs = 10)
        val started = System.nanoTime()
        assertEquals(Answer.NO_ANSWER, confirmations.ask("t", "x"))
        val tookMs = (System.nanoTime() - started) / 1_000_000
        assertTrue("waited the timeout, took $tookMs ms", tookMs in 100..1_500)
        assertEquals(1, sink.dismissed.size)
    }

    @Test
    fun `the timeout is a minute unless told otherwise`() {
        assertEquals(60_000L, Confirmations.TIMEOUT_MS)
    }

    @Test
    fun `pausing the agent while it waits ends the wait as a no`() {
        val sink = Sink()
        val paused = AtomicBoolean(false)
        val confirmations = Confirmations(sink, paused = { paused.get() }, timeoutMs = 5_000, pollMs = 10)
        Thread {
            while (sink.shown.isEmpty()) Thread.sleep(5)
            paused.set(true)
        }.start()
        assertEquals(Answer.PAUSED, confirmations.ask("t", "x"))
    }

    @Test
    fun `an answer to a question nobody is waiting on changes nothing`() {
        val sink = Sink()
        val confirmations = Confirmations(sink, paused = { false }, timeoutMs = 50, pollMs = 10)
        assertFalse(confirmations.answer(1234, true))
        confirmations.ask("t", "x")
        assertFalse("a late tap on a question that timed out", confirmations.answer(sink.shown.single().first, true))
    }

    @Test
    fun `each question has its own id`() {
        val sink = Sink()
        val confirmations = Confirmations(sink, paused = { false }, timeoutMs = 30, pollMs = 10)
        confirmations.ask("a", "x")
        confirmations.ask("b", "x")
        assertEquals(2, sink.shown.map { it.first }.distinct().size)
    }
}
