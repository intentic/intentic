package dev.intentic.device

import dev.intentic.device.tools.FrameLog
import dev.intentic.device.tools.FrameMath
import dev.intentic.device.tools.NoticeLog
import dev.intentic.device.tools.NoticeRecord
import dev.intentic.device.tools.ScreenCapture
import dev.intentic.device.tools.Schema
import dev.intentic.device.tools.Schemas
import dev.intentic.device.tools.ToolFailed
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class NoticeLogTest {
    private val own = "dev.intentic.device"

    private fun record(key: String, pkg: String = "com.chat", label: String = "Chat", time: Long, text: String = "hi") =
        NoticeRecord(key, pkg, label, "Title $key", text, time, "msg")

    @Test
    fun `the ring keeps the last 200 posted and drops the oldest`() {
        val log = NoticeLog(own)
        log.connect(emptyList())
        for (index in 1..250) {
            log.posted(record("k$index", time = index.toLong()))
            log.removed("k$index")
        }
        val history = log.history()
        assertEquals(200, history.size)
        assertEquals("k51", history.first().key)
        assertEquals("k250", history.last().key)
        val newest = log.recent(100, null)
        assertEquals(100, newest.size)
        assertEquals("k250", newest.first().record.key)
        assertEquals("k151", newest.last().record.key)
    }

    @Test
    fun `this app's own notifications are never recorded`() {
        val log = NoticeLog(own)
        log.connect(listOf(record("mine", pkg = own, time = 1), record("theirs", time = 2)))
        log.posted(record("mine2", pkg = own, time = 3))
        assertEquals(listOf("theirs"), log.recent(20, null).map { it.record.key })
    }

    @Test
    fun `what is showing is marked, and a removed notification stays in the history as not showing`() {
        val log = NoticeLog(own)
        log.connect(listOf(record("old", time = 1)))
        log.posted(record("new", time = 5))
        log.removed("new")
        val shown = log.recent(20, null).associate { it.record.key to it.showing }
        assertEquals(mapOf("new" to false, "old" to true), shown)
    }

    @Test
    fun `an updated notification appears once per post, and only its latest post is showing`() {
        val log = NoticeLog(own)
        log.connect(emptyList())
        log.posted(record("chat", time = 1, text = "first"))
        log.posted(record("chat", time = 2, text = "second"))
        val shown = log.recent(20, null)
        assertEquals(listOf("second", "first"), shown.map { it.record.text })
        assertEquals(listOf(true, false), shown.map { it.showing })
    }

    @Test
    fun `an app filter matches the package exactly or the label in part, and the limit is clamped`() {
        val log = NoticeLog(own)
        log.connect(emptyList())
        log.posted(record("a", pkg = "com.bank", label = "My Bank", time = 1))
        log.posted(record("b", pkg = "com.chat", label = "Chat", time = 2))
        assertEquals(listOf("a"), log.recent(20, "com.bank").map { it.record.key })
        assertEquals(listOf("a"), log.recent(20, "bank").map { it.record.key })
        assertTrue(log.recent(20, "com").isEmpty())
        assertEquals(1, log.recent(0, null).size)
        assertEquals(2, log.recent(1_000, null).size)
    }

    @Test
    fun `connecting starts the ring over, and disconnecting turns access off`() {
        val log = NoticeLog(own)
        assertFalse(log.connected)
        log.connect(emptyList())
        log.posted(record("x", time = 1))
        assertTrue(log.connected)
        log.connect(emptyList())
        assertTrue(log.recent(20, null).isEmpty())
        log.disconnect()
        assertFalse(log.connected)
    }
}

class NotificationsToolTest {
    private fun args(vararg pairs: Pair<String, Any>) = JSONObject().also { json -> pairs.forEach { json.put(it.first, it.second) } }
    private fun text(result: JSONObject) = result.getJSONArray("content").getJSONObject(0).getString("text")

    private fun phone(): FakePhone {
        val phone = FakePhone()
        phone.grant("notifications")
        phone.noticeLog.connect(emptyList())
        for (index in 1..30) {
            phone.noticeLog.posted(NoticeRecord("k$index", "com.chat", "Chat", "From $index", "Message $index", index * 1_000L, "msg"))
        }
        return phone
    }

    @Test
    fun `the default is the newest 20, and a limit above 100 is cut to 100`() {
        val phone = phone()
        val listed = text(phone.toolCall("notifications"))
        assertTrue(listed, listed.startsWith("20 notifications"))
        assertTrue(listed.contains("Message 30") && !listed.contains("Message 10\n") && !listed.contains("\"From 10\""))
        val few = text(phone.toolCall("notifications", args("limit" to 3)))
        assertTrue(few, few.startsWith("3 notifications"))
        assertTrue(text(phone.toolCall("notifications", args("limit" to 500))).startsWith("30 notifications"))
        assertTrue(phone.toolCall("notifications", args("limit" to 0)).getBoolean("isError"))
    }

    @Test
    fun `an app that posted nothing says so`() {
        val answer = text(phone().toolCall("notifications", args("app" to "com.nobody")))
        assertTrue(answer, answer.contains("No notifications from"))
    }
}

class ScreenCaptureAndFramesTest {
    @Test
    fun `screenshots need no prompt only when the touch service is bound on Android 11 or later`() {
        assertEquals("accessibility", ScreenCapture.mode(accessibilityBound = true, sdk = 30))
        assertEquals("accessibility", ScreenCapture.mode(accessibilityBound = true, sdk = 36))
        assertEquals("consent", ScreenCapture.mode(accessibilityBound = true, sdk = 29))
        assertEquals("consent", ScreenCapture.mode(accessibilityBound = false, sdk = 36))
    }

    @Test
    fun `a frame is read in the newest, and an older or unknown one is refused naming the newest`() {
        val log = FrameLog()
        try {
            log.resolve(null)
            fail("no frame yet")
        } catch (refused: ToolFailed) {
            assertTrue(refused.message!!.contains("no screenshot yet"))
        }
        val first = log.record(705, 1568, 1080, 2400)
        val second = log.record(705, 1568, 1080, 2400)
        assertEquals(1, first.id)
        assertEquals(second, log.resolve(null))
        assertEquals(second, log.resolve("f2"))
        assertEquals(second, log.resolve("2"))
        for (named in listOf("f1", "f9", "banana")) {
            try {
                log.resolve(named)
                fail("$named was accepted")
            } catch (refused: ToolFailed) {
                assertTrue(refused.message!!, refused.message!!.contains("f2") || refused.message!!.contains("not a frame id"))
            }
        }
    }

    @Test
    fun `a phone rectangle maps into a frame and back to the same pixels`() {
        val frame = FrameMath.Frame(1, 540, 1200, 1080, 2400)
        val box = FrameMath.toFrame(frame, 100, 200, 300, 400)
        assertEquals(FrameMath.Box(50, 100, 100, 100), box)
        val back = FrameMath.toPhone(frame, box.x, box.y)
        assertTrue(back.x in 100..103 && back.y in 200..203)
    }

    @Test
    fun `the schema reads a point as an array of two integers`() {
        val schema = Schemas.obj("to" to Schemas.point("end"), required = listOf("to"))
        assertNull(Schema.check(schema, JSONObject().put("to", JSONArray(listOf(5, 6)))))
        assertTrue(Schema.check(schema, JSONObject().put("to", JSONArray(listOf(5))))!!.contains("exactly 2 items"))
        assertTrue(Schema.check(schema, JSONObject().put("to", JSONArray(listOf(5, "x"))))!!.contains("must hold integers"))
        assertTrue(Schema.check(schema, JSONObject().put("to", "5,6"))!!.contains("must be an array"))
    }
}
