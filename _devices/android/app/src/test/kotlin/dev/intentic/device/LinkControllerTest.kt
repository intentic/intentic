package dev.intentic.device

import dev.intentic.device.link.LinkController
import dev.intentic.device.link.LinkState
import dev.intentic.device.protocol.DialPolicy
import dev.intentic.device.protocol.PhoneWire
import dev.intentic.device.store.LinkMode
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DialPolicyTest {
    @Test
    fun `the backoff climbs 1s 2s 4s 8s 16s then holds at 30s`() {
        val policy = DialPolicy()
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L, 30_000L), (1..8).map { policy.dropped(0) })
    }

    @Test
    fun `a link that held for a minute earns the floor back, a short one keeps climbing`() {
        val policy = DialPolicy()
        repeat(4) { policy.dropped(0) }
        assertEquals(16_000L, policy.dropped(59_999))
        assertEquals(1_000L, policy.dropped(60_000))
        assertEquals(2_000L, policy.dropped(0))
    }

    @Test
    fun `an open link starts the outage count over`() {
        val policy = DialPolicy()
        repeat(19) { policy.dropped(0) }
        assertEquals(19, policy.failuresInARow())
        policy.opened()
        assertEquals(0, policy.failuresInARow())
        assertEquals(30_000L, policy.dropped(0))
    }

    @Test
    fun `after twenty failures in a row it retries at most every fifteen minutes`() {
        val policy = DialPolicy()
        val waits = (1..22).map { policy.dropped(0) }
        assertEquals(30_000L, waits[18])
        assertEquals(DialPolicy.LONG_OUTAGE_MS, waits[19])
        assertEquals(DialPolicy.LONG_OUTAGE_MS, waits[21])
    }
}

class LinkControllerTest {
    private val scheduler = FakeScheduler()
    private val sockets = FakeSockets()
    private val host = FakeHost()
    private val answered = mutableListOf<String>()

    /** Time passing on an open link with the sandbox's heartbeat still arriving, as it does while the sandbox is there. */
    private fun quietFor(socket: FakeSocket, ms: Long) {
        var left = ms
        while (left > 0) {
            socket.listener.onMessage("ping")
            val step = minOf(left, PhoneWire.HEARTBEAT_MS)
            scheduler.advance(step)
            left -= step
        }
    }

    private fun controller(): LinkController =
        LinkController(host, sockets, scheduler, "0.1.0", { frame -> answered += frame; if (frame == "silent") null else "reply:$frame" }, DirectExecutor)

    @Test
    fun `waking dials the sandbox's connect url and sends the hello as the first frame`() {
        val link = controller()
        link.wake()
        val socket = sockets.opened.single()
        assertEquals("wss://box.example/system/phones/connect", socket.url)
        assertEquals(LinkState.CONNECTING, link.state)
        assertTrue(host.serviceWanted)
        socket.listener.onOpen()
        val hello = JSONObject(socket.sent.first())
        assertEquals("hello", hello.getString("type"))
        assertEquals("tok", hello.getString("token"))
        assertEquals("0.1.0", hello.getString("version"))
        assertEquals(1, socket.sent.size)
    }

    @Test
    fun `the first frame from the sandbox makes the link connected, and its requests are answered on the same socket`() {
        val link = controller()
        link.wake()
        val socket = sockets.opened.single()
        socket.listener.onOpen()
        socket.listener.onMessage("{\"id\":1}")
        assertEquals(LinkState.CONNECTED, link.state)
        assertEquals(listOf("{\"id\":1}"), answered)
        assertEquals("reply:{\"id\":1}", socket.sent.last())
        socket.listener.onMessage("silent")
        assertEquals(2, socket.sent.size)
    }

    @Test
    fun `closed 1008 means the pairing is revoked, so it is forgotten and dialling stops for good`() {
        val link = controller()
        host.mode = LinkMode.STAY
        link.wake()
        val socket = sockets.opened.single()
        socket.listener.onOpen()
        socket.listener.onEnded(PhoneWire.Close.UNAUTHORIZED)
        assertTrue(host.forgotten)
        assertEquals(LinkState.UNPAIRED, link.state)
        assertFalse(host.serviceWanted)
        scheduler.advance(3_600_000)
        assertEquals(1, sockets.opened.size)
        assertTrue(host.notes.any { it.contains("no longer recognizes") })
    }

    @Test
    fun `closed 1013 and every other close is retried on the ordinary ladder, never forgetting the pairing`() {
        host.mode = LinkMode.STAY
        val link = controller()
        link.wake()
        val codes = listOf(PhoneWire.Close.TRY_AGAIN, PhoneWire.Close.PROTOCOL_ERROR, PhoneWire.Close.GONE_QUIET, PhoneWire.Close.NORMAL, null)
        val waits = listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L)
        for ((index, code) in codes.withIndex()) {
            assertEquals(index + 1, sockets.opened.size)
            sockets.opened.last().listener.onEnded(code)
            assertEquals(LinkState.WAITING, link.state)
            scheduler.advance(waits[index] - 1)
            assertEquals("not before the ladder says ($code)", index + 1, sockets.opened.size)
            scheduler.advance(1)
            assertEquals(index + 2, sockets.opened.size)
        }
        assertFalse(host.forgotten)
    }

    @Test
    fun `a connection that never opened counts as a failure and the wait grows`() {
        host.mode = LinkMode.STAY
        val link = controller()
        link.wake()
        sockets.opened.last().listener.onEnded(null)
        scheduler.advance(1_000)
        sockets.opened.last().listener.onEnded(null)
        scheduler.advance(1_999)
        assertEquals(2, sockets.opened.size)
        scheduler.advance(1)
        assertEquals(3, sockets.opened.size)
    }

    @Test
    fun `three heartbeats of silence abandon the socket and redial`() {
        host.mode = LinkMode.STAY
        val link = controller()
        link.wake()
        val socket = sockets.opened.single()
        socket.listener.onOpen()
        socket.listener.onMessage("ping")
        scheduler.advance(PhoneWire.SILENCE_MS - 1)
        assertFalse(socket.cancelled)
        scheduler.advance(1)
        assertTrue(socket.cancelled)
        assertEquals(LinkState.WAITING, link.state)
        scheduler.advance(1_000)
        assertEquals(2, sockets.opened.size)
    }

    @Test
    fun `any frame from the sandbox keeps the link alive`() {
        host.mode = LinkMode.STAY
        val link = controller()
        link.wake()
        val socket = sockets.opened.single()
        socket.listener.onOpen()
        repeat(5) {
            scheduler.advance(PhoneWire.HEARTBEAT_MS)
            socket.listener.onMessage("ping")
        }
        assertFalse(socket.cancelled)
        assertEquals(LinkState.CONNECTED, link.state)
    }

    @Test
    fun `on demand closes normally after five minutes with no tools call, and a call restarts the five minutes`() {
        val link = controller()
        link.wake()
        val socket = sockets.opened.single()
        socket.listener.onOpen()
        socket.listener.onMessage("x")
        quietFor(socket, PhoneWire.LINGER_MS - 60_000)
        link.activity()
        quietFor(socket, PhoneWire.LINGER_MS - 1)
        assertNull(socket.closedWith)
        quietFor(socket, 1)
        assertEquals(PhoneWire.Close.NORMAL, socket.closedWith!!.first)
        assertEquals(LinkState.IDLE, link.state)
        assertFalse(host.serviceWanted)
        scheduler.advance(3_600_000)
        assertEquals("a normal close is not redialled", 1, sockets.opened.size)
    }

    @Test
    fun `on demand gives up retrying once the linger has passed, and a new wake dials at once`() {
        val link = controller()
        link.wake()
        repeat(40) {
            sockets.opened.last().listener.onEnded(null)
            scheduler.advance(30_000)
        }
        assertEquals(LinkState.IDLE, link.state)
        assertFalse(host.serviceWanted)
        val tried = sockets.opened.size
        scheduler.advance(3_600_000)
        assertEquals(tried, sockets.opened.size)
        link.wake()
        assertEquals(tried + 1, sockets.opened.size)
    }

    @Test
    fun `stay connected never lingers out and starts again after a drop`() {
        host.mode = LinkMode.STAY
        val link = controller()
        link.wake()
        val socket = sockets.opened.single()
        socket.listener.onOpen()
        socket.listener.onMessage("x")
        quietFor(socket, PhoneWire.LINGER_MS * 5)
        assertNull(socket.closedWith)
        socket.listener.onEnded(PhoneWire.Close.GONE_QUIET)
        scheduler.advance(1_000)
        assertEquals(2, sockets.opened.size)
    }

    @Test
    fun `a reply that finishes after its socket was closed is not sent to the next one`() {
        host.mode = LinkMode.STAY
        val late = mutableListOf<Runnable>()
        val link = LinkController(host, sockets, scheduler, "0.1.0", { "reply" }, { late += it })
        link.wake()
        val first = sockets.opened.single()
        first.listener.onOpen()
        first.listener.onMessage("slow")
        first.listener.onEnded(null)
        scheduler.advance(1_000)
        val second = sockets.opened.last()
        late.forEach { it.run() }
        assertTrue(first.sent.none { it == "reply" })
        assertTrue(second.sent.none { it == "reply" })
    }

    @Test
    fun `unpairing closes the link and a revoked or cleared pairing leaves it unpaired`() {
        host.mode = LinkMode.STAY
        val link = controller()
        link.wake()
        val socket = sockets.opened.single()
        socket.listener.onOpen()
        host.pairing = null
        link.pairingChanged()
        assertEquals(PhoneWire.Close.NORMAL, socket.closedWith!!.first)
        assertEquals(LinkState.UNPAIRED, link.state)
        assertFalse(host.serviceWanted)
    }

    @Test
    fun `waking with no pairing dials nothing`() {
        host.pairing = null
        val link = controller()
        link.wake()
        assertTrue(sockets.opened.isEmpty())
        assertEquals(LinkState.UNPAIRED, link.state)
    }
}
