package dev.intentic.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EventsTest {
    private val posted = mutableListOf<Runnable>()
    private val events = Events { posted += it }
    private val pong = """{"type":"Reply","content":{"id":3,"outcome":{"type":"Pong","content":{"echo":"x"}}}}"""

    @Test
    fun anEventReachesObserversOnlyThroughPost() {
        val seen = mutableListOf<Event>()
        events.observe { seen += it }
        events.deliver(pong)
        assertTrue("decoded on the core's thread, handed over by post", seen.isEmpty())
        posted.forEach(Runnable::run)
        assertEquals(listOf(Wire.decodeEvent(pong)), seen)
    }

    @Test
    fun aClosedObserverHearsNothingMore() {
        val seen = mutableListOf<Event>()
        events.observe { seen += it }.close()
        events.deliver(pong)
        posted.forEach(Runnable::run)
        assertTrue(seen.isEmpty())
    }

    @Test
    fun anUnreadableEventIsDroppedRatherThanThrownIntoTheCore() {
        events.deliver("""{"type":"Unknown","content":{}}""")
        events.deliver("not json")
        assertTrue(posted.isEmpty())
    }
}
