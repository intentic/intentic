package dev.intentic.device

import dev.intentic.device.policy.Gate
import dev.intentic.device.policy.Switch
import dev.intentic.device.protocol.McpServer
import dev.intentic.device.protocol.PhoneWire
import dev.intentic.device.tools.Shot
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class McpServerTest {
    private val stage1Tools = listOf("describe", "screenshot", "open", "apps", "ask_access", "list_dir", "read_file", "write_file", "trash_file", "clipboard", "notifications")

    private fun text(result: JSONObject): String = result.getJSONArray("content").getJSONObject(0).getString("text")

    private fun names(list: JSONObject): List<String> = list.getJSONObject("result").getJSONArray("tools").let { array -> (0 until array.length()).map { array.getJSONObject(it).getString("name") } }

    @Test
    fun `initialize answers the protocol version, tools capability and server info`() {
        val answer = FakePhone().mcpCall("initialize", JSONObject().put("protocolVersion", "2025-06-18"), id = 1)
        assertEquals(1, answer.getInt("id"))
        val result = answer.getJSONObject("result")
        assertEquals("2025-06-18", result.getString("protocolVersion"))
        assertTrue(result.getJSONObject("capabilities").has("tools"))
        assertEquals("0.1.0", result.getJSONObject("serverInfo").getString("version"))
    }

    @Test
    fun `ping answers an empty result and echoes a string id`() {
        val answer = FakePhone().mcpCall("ping", id = "abc")
        assertEquals("abc", answer.getString("id"))
        assertEquals(0, answer.getJSONObject("result").length())
    }

    @Test
    fun `tools list names every stage 1 tool with a description, an object schema and both annotation hints`() {
        val list = FakePhone().mcpCall("tools/list")
        assertEquals(stage1Tools, names(list))
        val tools = list.getJSONObject("result").getJSONArray("tools")
        for (index in 0 until tools.length()) {
            val tool = tools.getJSONObject(index)
            assertTrue("${tool.getString("name")} has a description", tool.getString("description").length > 20)
            assertEquals("object", tool.getJSONObject("inputSchema").getString("type"))
            val annotations = tool.getJSONObject("annotations")
            assertTrue(annotations.has("readOnlyHint") && annotations.has("destructiveHint"))
        }
        val byName = (0 until tools.length()).associate { tools.getJSONObject(it).getString("name") to tools.getJSONObject(it) }
        assertTrue(byName.getValue("screenshot").getJSONObject("annotations").getBoolean("readOnlyHint"))
        assertFalse(byName.getValue("write_file").getJSONObject("annotations").getBoolean("readOnlyHint"))
        assertTrue(byName.getValue("write_file").getJSONObject("annotations").getBoolean("destructiveHint"))
        assertEquals(listOf("folder", "path", "content"), byName.getValue("write_file").getJSONObject("inputSchema").getJSONArray("required").let { a -> (0 until a.length()).map { a.getString(it) } })
    }

    @Test
    fun `a notification gets no answer and an unknown method is a JSON-RPC error`() {
        val phone = FakePhone()
        val silent = phone.call("mcp", JSONObject().put("jsonrpc", "2.0").put("method", "notifications/initialized")).get("result")
        assertEquals(JSONObject.NULL, silent)
        val unknown = phone.mcpCall("resources/list")
        assertEquals(PhoneWire.Error.METHOD_NOT_FOUND, unknown.getJSONObject("error").getInt("code"))
        val invalid = phone.call("mcp", JSONArray()).getJSONObject("result")
        assertEquals(PhoneWire.Error.INVALID_REQUEST, invalid.getJSONObject("error").getInt("code"))
    }

    /** The order the sandbox uses right after the hello: tools/list, then setScopes, then describe (_sandbox/sandbox/src/phones/phone-door.integration.test.ts). */
    @Test
    fun `the sandbox's greeting order works, with tools list and describe answered before any grant and tools call not`() {
        val phone = FakePhone()
        assertEquals(stage1Tools, names(phone.mcpCall("tools/list")))

        assertEquals(true, phone.call("setScopes", JSONObject().put("screen", "on").put("platform", "android")).getJSONObject("result").getBoolean("ok"))
        assertEquals("Google Pixel 8", phone.call("describe").getJSONObject("result").getString("device"))
        // The grant says the screen only; the others were sent as absent, so they are off.
        val refused = phone.toolCall("list_dir", JSONObject().put("folder", "x"))
        assertTrue(refused.getBoolean("isError"))
        assertEquals(Gate.switchOff(Switch.FILES), text(refused))
    }

    @Test
    fun `before the first setScopes every tool call is refused, while describe ping and tools list still answer`() {
        val phone = FakePhone()
        assertEquals(11, names(phone.mcpCall("tools/list")).size)
        assertEquals(true, phone.call("ping").getJSONObject("result").getBoolean("ok"))
        assertNotNull(phone.call("describe").getJSONObject("result"))
        assertNotNull(phone.mcpCall("initialize"))
        for (tool in stage1Tools) {
            val result = phone.toolCall(tool, validArguments(tool))
            assertTrue("$tool is refused before the first setScopes", result.getBoolean("isError"))
            assertEquals(Gate.NOT_GRANTED_YET, text(result))
        }
    }

    @Test
    fun `every tool behind a switch is refused with that switch off, naming it as the owner sees it`() {
        val behind = mapOf(
            "screenshot" to Switch.SCREEN, "open" to Switch.APPS, "apps" to Switch.APPS, "list_dir" to Switch.FILES, "read_file" to Switch.FILES,
            "write_file" to Switch.WRITE, "trash_file" to Switch.WRITE, "clipboard" to Switch.CONTROL, "notifications" to Switch.NOTIFICATIONS,
        )
        val phone = FakePhone()
        phone.folders.add("Notes", "content://tree", writable = true)
        phone.grant() // every switch off
        for ((tool, switch) in behind) {
            val result = phone.toolCall(tool, validArguments(tool))
            assertTrue("$tool is refused with ${switch.key} off", result.getBoolean("isError"))
            assertEquals(Gate.switchOff(switch), text(result))
            assertTrue(text(result).contains("\"${switch.label}\""))
        }
        assertEquals(0, phone.screen.asked)
        assertTrue(phone.apps.opened.isEmpty())
        assertEquals(null, phone.clipboard.text)
        assertTrue(phone.files.content.isEmpty())
        // The labels the sandbox's card shows.
        assertEquals("See the screen", Switch.SCREEN.label)
        assertEquals("Read the folders you pick", Switch.FILES.label)
        assertEquals("Change files in those folders", Switch.WRITE.label)
        assertEquals("Open apps and links", Switch.APPS.label)
    }

    @Test
    fun `describe and ask_access are not behind a switch, but the pause and the missing grant still refuse them`() {
        val phone = FakePhone()
        phone.grant()
        assertFalse(phone.toolCall("describe").getBoolean("isError"))
        assertFalse(phone.toolCall("ask_access", validArguments("ask_access")).getBoolean("isError"))
    }

    @Test
    fun `while paused every tool call is refused with the person's sentence, and facts say paused`() {
        val phone = FakePhone()
        phone.grant("screen", "control", "files", "write", "notifications", "apps", "destructive")
        phone.folders.add("Notes", "content://tree", writable = true)
        phone.settings.paused = true
        for (tool in stage1Tools) {
            val result = phone.toolCall(tool, validArguments(tool))
            assertTrue("$tool is refused while paused", result.getBoolean("isError"))
            assertEquals("The person paused the agent on this phone.", text(result))
        }
        assertEquals(0, phone.screen.asked)
        assertEquals(true, phone.call("describe").getJSONObject("result").getBoolean("paused"))
        // The pause does not stop the handshake or the heartbeat.
        assertEquals(stage1Tools, names(phone.mcpCall("tools/list")))
        assertEquals(true, phone.call("ping").getJSONObject("result").getBoolean("ok"))
        phone.settings.paused = false
        assertFalse(phone.toolCall("describe").getBoolean("isError"))
        assertEquals(false, phone.call("describe").getJSONObject("result").getBoolean("paused"))
    }

    @Test
    fun `an unknown switch value or key never turns anything on, and the last grant replaces the one before`() {
        val phone = FakePhone()
        phone.call("setScopes", JSONObject().put("screen", "on").put("files", "maybe").put("teleport", "on"))
        assertTrue(phone.scopes.current()!!.allows(Switch.SCREEN))
        assertFalse(phone.scopes.current()!!.allows(Switch.FILES))
        phone.call("setScopes", JSONObject().put("files", "on"))
        assertFalse(phone.scopes.current()!!.allows(Switch.SCREEN))
        assertTrue(phone.scopes.current()!!.allows(Switch.FILES))
    }

    @Test
    fun `the last grant is what a restart enforces`() {
        val phone = FakePhone()
        phone.grant("screen", confirm = "always")
        val restarted = dev.intentic.device.policy.ScopeStore(phone.kv)
        assertTrue(restarted.current()!!.allows(Switch.SCREEN))
        assertEquals("always", restarted.current()!!.confirm.key)
        restarted.clear()
        assertEquals(null, dev.intentic.device.policy.ScopeStore(phone.kv).current())
    }

    @Test
    fun `android blocking the connected notice refuses calls, naming why`() {
        val phone = FakePhone()
        phone.grant("apps")
        phone.noticeVisible = false
        assertEquals(Gate.NOTICE_HIDDEN, text(phone.toolCall("apps")))
        phone.noticeVisible = true
        assertFalse(phone.toolCall("apps").getBoolean("isError"))
    }

    @Test
    fun `a call is counted as activity even when it is refused`() {
        val phone = FakePhone()
        phone.toolCall("apps")
        phone.toolCall("nope")
        assertEquals(2, phone.toolCalls)
    }

    @Test
    fun `unknown tools and bad arguments are errors a model can read`() {
        val phone = FakePhone()
        phone.grant("screen", "files", "apps")
        assertTrue(text(phone.toolCall("teleport")).contains("no tool \"teleport\""))
        val missing = phone.toolCall("list_dir")
        assertTrue(missing.getBoolean("isError"))
        assertTrue(text(missing).contains("\"folder\" is required"))
        val wrongType = phone.toolCall("read_file", JSONObject().put("folder", "a").put("path", "b").put("offset", "two"))
        assertTrue(text(wrongType).contains("\"offset\" must be an integer"))
        val extra = phone.toolCall("apps", JSONObject().put("bogus", 1))
        assertTrue(text(extra).contains("\"bogus\" is not an argument"))
    }

    @Test
    fun `the activity log is told of every outcome, refused calls included`() {
        val phone = FakePhone()
        phone.grant("apps")
        phone.toolCall("apps")
        phone.toolCall("screenshot")
        assertEquals(listOf("apps", "screenshot"), phone.audit.entries.map { it.first })
        assertEquals("ok", phone.audit.entries[0].third)
        assertTrue(phone.audit.entries[1].third.startsWith("refused"))
    }

    @Test
    fun `screenshot asks on the phone when no session is approved, and answers with an image and its frame once one is`() {
        val phone = FakePhone()
        phone.grant("screen")
        val asked = phone.toolCall("screenshot")
        assertFalse(asked.getBoolean("isError"))
        assertEquals("Asked on the phone to share the screen; call screenshot again once they have.", text(asked))
        assertEquals(1, phone.screen.asked)

        phone.screen.shot = Shot(byteArrayOf(1, 2, 3), 705, 1568, 1080, 2400)
        val shown = phone.toolCall("screenshot").getJSONArray("content")
        assertEquals("image", shown.getJSONObject(0).getString("type"))
        assertEquals("image/jpeg", shown.getJSONObject(0).getString("mimeType"))
        assertEquals("AQID", shown.getJSONObject(0).getString("data"))
        val caption = shown.getJSONObject(1).getString("text")
        assertTrue(caption, Regex("^frame f\\d+, 705x1568 \\(phone pixels 1080x2400\\)$").matches(caption))
        val next = phone.toolCall("screenshot").getJSONArray("content").getJSONObject(1).getString("text")
        val first = Regex("f(\\d+)").find(caption)!!.groupValues[1].toInt()
        assertEquals("frames are numbered in order", first + 1, Regex("f(\\d+)").find(next)!!.groupValues[1].toInt())
    }

    @Test
    fun `open posts a notification request for a link or an app and says so, and refuses what is not an http link`() {
        val phone = FakePhone()
        phone.grant("apps")
        val link = phone.toolCall("open", JSONObject().put("url", "https://example.com/a?b=1"))
        assertTrue(text(link).contains("example.com") && text(link).contains("taps"))
        val app = phone.toolCall("open", JSONObject().put("app", "com.android.chrome"))
        assertTrue(text(app).contains("Chrome") && text(app).contains("taps"))
        assertEquals(listOf("link:https://example.com/a?b=1", "app:com.android.chrome"), phone.apps.opened)
        for (bad in listOf("javascript:alert(1)", "intent://x#Intent;end", "file:///sdcard/x", "https://", "https://exa mple.com")) {
            assertTrue("$bad is refused", phone.toolCall("open", JSONObject().put("url", bad)).getBoolean("isError"))
        }
        assertTrue(phone.toolCall("open", JSONObject()).getBoolean("isError"))
        assertTrue(phone.toolCall("open", JSONObject().put("url", "https://a.b").put("app", "x")).getBoolean("isError"))
        assertTrue(phone.toolCall("open", JSONObject().put("app", "no.such.app")).getBoolean("isError"))
        assertEquals(2, phone.apps.opened.size)
    }

    @Test
    fun `apps lists launchable apps with what the person allowed in each`() {
        val phone = FakePhone()
        phone.grant("apps")
        phone.allowList.put(dev.intentic.device.store.AllowedApp("com.android.chrome", "Chrome", dev.intentic.device.store.AppMode.ACT, sensitive = true))
        val listed = text(phone.toolCall("apps"))
        assertTrue(listed, listed.contains("Chrome (com.android.chrome): act (sensitive)"))
        assertTrue(listed, listed.contains("Notes (org.example.notes): none"))
    }

    @Test
    fun `ask_access records a request and never grants`() {
        val phone = FakePhone()
        phone.grant()
        val answer = phone.toolCall("ask_access", JSONObject().put("app", "org.example.notes").put("mode", "act").put("reason", "to add your shopping list"))
        assertFalse(answer.getBoolean("isError"))
        assertTrue(text(answer).startsWith("Asked on the phone"))
        assertEquals(listOf(Triple("org.example.notes", dev.intentic.device.store.AppMode.ACT, "to add your shopping list")), phone.apps.asks)
        assertTrue(phone.allowList.all().isEmpty())
        assertTrue(phone.toolCall("ask_access", JSONObject().put("app", "org.example.notes").put("mode", "everything").put("reason", "x")).getBoolean("isError"))
        assertTrue(phone.toolCall("ask_access", JSONObject().put("app", "no.such").put("mode", "read").put("reason", "x")).getBoolean("isError"))
    }

    @Test
    fun `clipboard puts text on the clipboard`() {
        val phone = FakePhone()
        phone.grant("control")
        assertFalse(phone.toolCall("clipboard", JSONObject().put("text", "hello")).getBoolean("isError"))
        assertEquals("hello", phone.clipboard.text)
    }

    @Test
    fun `describe says whether touch and notification access are on`() {
        val phone = FakePhone()
        phone.grant()
        val said = text(phone.toolCall("describe"))
        assertTrue(said, said.contains("Touch and type (accessibility service): off or not in this build.") && said.contains("Notification access: off."))
        assertTrue(said, said.contains("Screen capture: Android asks the person once per session."))
    }

    @Test
    fun `notifications is refused while notification access is off, and lists what the listener saw once it is on`() {
        val phone = FakePhone()
        phone.grant("notifications")
        val off = phone.toolCall("notifications")
        assertTrue(off.getBoolean("isError"))
        assertTrue(text(off), text(off).contains("notification access is not switched on"))
        phone.noticeLog.connect(emptyList())
        phone.noticeLog.posted(dev.intentic.device.tools.NoticeRecord("k1", "com.bank", "Bank", "Your code", "Code 123456", 1_000, "msg"))
        val on = text(phone.toolCall("notifications"))
        assertTrue(on, on.contains("Bank (com.bank)") && on.contains("\"Your code\"") && on.contains("Code 123456") && on.contains("showing"))
    }

    private fun validArguments(tool: String): JSONObject =
        when (tool) {
            "open" -> JSONObject().put("url", "https://example.com")
            "ask_access" -> JSONObject().put("app", "org.example.notes").put("mode", "read").put("reason", "to look")
            "list_dir" -> JSONObject().put("folder", "Notes")
            "read_file" -> JSONObject().put("folder", "Notes").put("path", "a.txt")
            "write_file" -> JSONObject().put("folder", "Notes").put("path", "a.txt").put("content", "x")
            "trash_file" -> JSONObject().put("folder", "Notes").put("path", "a.txt")
            "clipboard" -> JSONObject().put("text", "x")
            else -> JSONObject()
        }
}
