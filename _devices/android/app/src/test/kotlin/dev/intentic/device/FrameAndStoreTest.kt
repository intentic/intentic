package dev.intentic.device

import dev.intentic.device.policy.Scopes
import dev.intentic.device.policy.Switch
import dev.intentic.device.store.AccessRequest
import dev.intentic.device.store.AccessRequests
import dev.intentic.device.store.ActivityLog
import dev.intentic.device.store.AesGcmBox
import dev.intentic.device.store.AllowedApp
import dev.intentic.device.store.AppAllowList
import dev.intentic.device.store.AppMode
import dev.intentic.device.store.FolderStore
import dev.intentic.device.store.Pairing
import dev.intentic.device.store.PairingStore
import dev.intentic.device.tools.FrameMath
import dev.intentic.device.tools.Schema
import dev.intentic.device.tools.Schemas
import dev.intentic.device.tools.ToolFailed
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import javax.crypto.KeyGenerator

class FrameMathTest {
    @Test
    fun `a tall phone screen is shrunk until its long side is at most 1568, keeping its shape`() {
        val size = FrameMath.fit(1080, 2400)
        assertEquals(1568, size.height)
        assertEquals(705, size.width)
        assertTrue(maxOf(size.width, size.height) <= FrameMath.MAX_EDGE)
        assertEquals(1080.0 / 2400, size.width.toDouble() / size.height, 0.002)
    }

    @Test
    fun `a screen already small enough is never enlarged`() {
        assertEquals(FrameMath.Size(720, 1280), FrameMath.fit(720, 1280))
        assertEquals(FrameMath.Size(1, 1), FrameMath.fit(1, 1))
    }

    @Test
    fun `a wide tablet is held to the pixel budget as well as the edge`() {
        val size = FrameMath.fit(2560, 1600)
        assertTrue(size.width <= FrameMath.MAX_EDGE && size.height <= FrameMath.MAX_EDGE)
        assertTrue(size.width.toLong() * size.height <= FrameMath.MAX_PIXELS)
    }

    @Test
    fun `an image pixel maps to the phone pixel at its centre`() {
        val frame = FrameMath.Frame(1, 705, 1568, 1080, 2400)
        assertEquals(FrameMath.Point(0, 0), FrameMath.toPhone(frame, 0, 0))
        val middle = FrameMath.toPhone(frame, 352, 784)
        assertTrue(middle.x in 539..540 && middle.y in 1200..1201)
        val last = FrameMath.toPhone(frame, 704, 1567)
        assertTrue(last.x in 1078..1079 && last.y in 2398..2399)
        val unscaled = FrameMath.Frame(2, 100, 200, 100, 200)
        assertEquals(FrameMath.Point(10, 20), FrameMath.toPhone(unscaled, 10, 20))
    }

    @Test
    fun `a point outside the image is refused naming the frame`() {
        val frame = FrameMath.Frame(7, 705, 1568, 1080, 2400)
        for ((x, y) in listOf(-1 to 0, 0 to -1, 705 to 0, 0 to 1568)) {
            try {
                FrameMath.toPhone(frame, x, y)
                fail("($x, $y) was accepted")
            } catch (refused: ToolFailed) {
                assertTrue(refused.message!!.contains("f7"))
            }
        }
    }

    @Test
    fun `the caption names the frame, the image size and the phone size`() {
        assertEquals("frame f3, 705x1568 (phone pixels 1080x2400)", FrameMath.caption(FrameMath.Frame(3, 705, 1568, 1080, 2400)))
    }
}

class SchemaTest {
    private val schema = Schemas.obj(
        "folder" to Schemas.string("f"),
        "mode" to Schemas.choice("m", "read", "act"),
        "offset" to Schemas.integer("o"),
        required = listOf("folder"),
    )

    @Test
    fun `valid arguments pass`() {
        assertNull(Schema.check(schema, JSONObject().put("folder", "x").put("mode", "read").put("offset", 3)))
    }

    @Test
    fun `problems are listed in words a model can fix its call with`() {
        val problems = Schema.check(schema, JSONObject().put("mode", "write").put("offset", 0).put("extra", true))!!
        assertTrue(problems, problems.contains("\"folder\" is required"))
        assertTrue(problems, problems.contains("\"mode\" must be one of \"read\", \"act\""))
        assertTrue(problems, problems.contains("\"offset\" must be at least 1"))
        assertTrue(problems, problems.contains("\"extra\" is not an argument"))
        assertTrue(Schema.check(schema, JSONObject().put("folder", 5))!!.contains("must be a string"))
        assertTrue(Schema.check(schema, JSONObject().put("folder", "x").put("offset", 1.5))!!.contains("must be an integer"))
    }
}

class StoresTest {
    @Test
    fun `an activity entry keeps text and content to 40 characters and any other string to 200`() {
        val redacted = ActivityLog.redact(
            JSONObject().put("text", "a".repeat(100)).put("content", "b".repeat(41)).put("path", "p".repeat(300)).put("limit", 5).put("short", "ok"),
        )
        assertEquals("a".repeat(40) + "...", redacted.getString("text"))
        assertEquals("b".repeat(40) + "...", redacted.getString("content"))
        assertEquals(203, redacted.getString("path").length)
        assertEquals(5, redacted.getInt("limit"))
        assertEquals("ok", redacted.getString("short"))
        assertEquals("c".repeat(40), ActivityLog.redact(JSONObject().put("text", "c".repeat(40))).getString("text"))
    }

    @Test
    fun `the log keeps what happened newest first, and shows at most the last 100`() {
        val dir = File.createTempFile("activity", "").also { it.delete(); it.mkdirs() }
        var clock = 1_000L
        val log = ActivityLog(File(dir, "activity.jsonl")) { clock++ }
        repeat(130) { log.record("tool$it", JSONObject().put("text", "secret ".repeat(20)), "ok") }
        log.event("Paused by the owner")
        val shown = log.last()
        assertEquals(100, shown.size)
        assertEquals("Paused by the owner", shown.first().text)
        assertEquals("tool129", shown[1].tool)
        assertEquals("tool31", shown.last().tool)
        assertTrue(shown[1].args!!.contains("secret secret"))
        assertFalse(File(dir, "activity.jsonl").readText().contains("secret ".repeat(10)))
        assertEquals(emptyList<ActivityLog.Entry>(), ActivityLog(File(dir, "none.jsonl")).last())
    }

    @Test
    fun `the log is trimmed rather than growing without end`() {
        val dir = File.createTempFile("activity", "").also { it.delete(); it.mkdirs() }
        val file = File(dir, "activity.jsonl")
        val log = ActivityLog(file)
        repeat(3_000) { log.record("read_file", JSONObject().put("path", "p".repeat(150)), "ok") }
        assertTrue(file.length() < 400 * 1024)
        assertEquals(100, log.last().size)
    }

    @Test
    fun `a sealed token opens only with its key and not when altered`() {
        val generator = KeyGenerator.getInstance("AES").also { it.init(256) }
        val key = generator.generateKey()
        val box = AesGcmBox { key }
        val sealed = box.seal("iph_secret-token")
        assertFalse(sealed.contains("iph_secret"))
        assertEquals("iph_secret-token", box.open(sealed))
        assertNotEquals("a fresh IV each time", sealed, box.seal("iph_secret-token"))
        assertNull(AesGcmBox { generator.generateKey() }.open(sealed))
        assertNull(box.open(sealed.dropLast(3) + "AAA"))
        assertNull(box.open("not sealed"))
        assertNull(box.open(""))
    }

    @Test
    fun `a pairing is stored sealed and read back, and clearing forgets it`() {
        val kv = MemoryKv()
        val key = KeyGenerator.getInstance("AES").also { it.init(256) }.generateKey()
        val box = AesGcmBox { key }
        val store = PairingStore(kv, box)
        assertNull(store.get())
        store.save(Pairing("https://box.example", "pixel", "iph_tok"))
        assertFalse(kv.getString("pairing.token")!!.contains("iph_tok"))
        assertEquals(Pairing("https://box.example", "pixel", "iph_tok"), PairingStore(kv, box).get())
        // A key that is gone means no pairing, not a crash.
        assertNull(PairingStore(kv, AesGcmBox { KeyGenerator.getInstance("AES").also { it.init(256) }.generateKey() }).get())
        store.clear()
        assertNull(PairingStore(kv, box).get())
    }

    @Test
    fun `folders get unique names and are found by name`() {
        val folders = FolderStore(MemoryKv())
        assertEquals("Download", folders.add("Download", "content://a", false).name)
        assertEquals("Download (2)", folders.add("Download", "content://b", true).name)
        assertEquals("content://b", folders.find("download (2)")!!.uri)
        assertEquals(2, folders.all().size)
        assertEquals("content://a", folders.remove("Download")!!.uri)
        assertNull(folders.find("Download"))
        assertEquals(1, folders.clear().size)
    }

    @Test
    fun `the allow list keeps the owner's choices and a request never grants by itself`() {
        val kv = MemoryKv()
        val allow = AppAllowList(kv)
        val requests = AccessRequests(kv)
        val now = System.currentTimeMillis()
        assertTrue(requests.add(AccessRequest("com.bank", "Bank", AppMode.ACT, "pay a bill", now)))
        assertFalse("the same ask again changes nothing", requests.add(AccessRequest("com.bank", "Bank", AppMode.ACT, "again", now)))
        assertTrue(allow.all().isEmpty())
        allow.put(AllowedApp("com.bank", "Bank", AppMode.READ, sensitive = true))
        allow.put(AllowedApp("com.bank", "Bank", AppMode.ACT, sensitive = true))
        assertEquals(listOf(AllowedApp("com.bank", "Bank", AppMode.ACT, true)), AppAllowList(kv).all())
        allow.remove("com.bank")
        assertTrue(allow.all().isEmpty())
    }

    @Test
    fun `a no is remembered for an hour`() {
        var now = 0L
        val requests = AccessRequests(MemoryKv()) { now }
        assertFalse(requests.deniedRecently("com.bank", AppMode.ACT))
        requests.deny("com.bank", AppMode.ACT)
        assertTrue(requests.deniedRecently("com.bank", AppMode.ACT))
        assertFalse(requests.deniedRecently("com.bank", AppMode.READ))
        now += AccessRequests.COOLDOWN_MS
        assertFalse(requests.deniedRecently("com.bank", AppMode.ACT))
    }

    @Test
    fun `a request expires after a day and only eight wait at once`() {
        var now = 0L
        val requests = AccessRequests(MemoryKv()) { now }
        repeat(8) { assertTrue(requests.add(AccessRequest("app$it", "App", AppMode.READ, "r", now))) }
        assertFalse(requests.add(AccessRequest("app9", "App", AppMode.READ, "r", now)))
        now += AccessRequests.EXPIRES_MS
        assertTrue(requests.all().isEmpty())
    }

    @Test
    fun `scopes read unknown confirm values as the most careful one`() {
        assertEquals("always", Scopes.fromParams(JSONObject().put("confirm", "whenever")).confirm.key)
        assertEquals("sensitive", Scopes.fromParams(JSONObject()).confirm.key)
        assertEquals(setOf(Switch.APPS), Scopes.fromParams(JSONObject().put("apps", "on").put("platform", "android")).on)
    }
}
