package dev.intentic.device.touch

import dev.intentic.device.store.AppMode
import dev.intentic.device.tools.ToolRefused
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class UiElementsToolTest {
    private val rig = TouchRig()

    @Test
    fun `it lists the screen of the app that is on it, with refs`() {
        rig.port.tree = screenOf(label("Hello"), button("Send"))
        val listed = rig.call("ui_elements")
        assertFalse(rig.isError(listed))
        val text = rig.text(listed)
        assertTrue(text, text.contains("Foreground app: App (com.app)"))
        assertTrue(text, text.contains("[e1] text \"Hello\"") && text.contains("[e2] button \"Send\""))
    }

    @Test
    fun `it is refused while the touch service is off`() {
        rig.port.isBound = false
        val said = rig.text(rig.call("ui_elements"))
        assertTrue(said, said.contains("touch service is not switched on") && said.contains("Accessibility"))
    }

    @Test
    fun `it needs the screen switch`() {
        rig.phone.grant("control")
        rig.port.tree = screenOf(label("Hello"))
        val said = rig.text(rig.call("ui_elements"))
        assertTrue(said, said.contains("\"See the screen\""))
    }

    @Test
    fun `it needs the app on screen to be on the list, and read is enough`() {
        rig.port.tree = screenOf(label("Hello"))
        rig.port.foreground = Foreground("com.bank", "Bank")
        val said = rig.text(rig.call("ui_elements"))
        assertTrue(said, said.contains("ask_access") && said.contains("com.bank"))
        rig.allow("com.bank", "Bank", AppMode.READ)
        assertFalse(rig.isError(rig.call("ui_elements")))
        rig.port.foreground = null
        assertTrue(rig.text(rig.call("ui_elements")).contains("no active window"))
    }

    @Test
    fun `a screen that cannot be read is an error to retry`() {
        rig.port.tree = null
        assertTrue(rig.text(rig.call("ui_elements")).contains("could not be read"))
    }
}

class UiActToolTest {
    private val rig = TouchRig()

    private fun list(vararg nodes: FakeNode) {
        rig.port.tree = screenOf(*nodes)
        rig.call("ui_elements")
    }

    @Test
    fun `a tap clicks the element, lets the screen settle, and attaches a fresh frame`() {
        val send = button("Send")
        rig.withScreenshot()
        list(label("Hi"), send)
        val done = rig.call("ui_act", "ref" to "e2", "action" to "tap")
        assertFalse(rig.isError(done))
        assertEquals("Tapped [e2] \"Send\".", rig.text(done))
        assertEquals(listOf("click"), send.performed)
        assertEquals(listOf(600L), rig.slept)
        val blocks = done.getJSONArray("content")
        assertEquals(listOf("text", "image", "text"), (0 until blocks.length()).map { blocks.getJSONObject(it).getString("type") })
        assertTrue(blocks.getJSONObject(2).getString("text").startsWith("frame f1, 705x1568"))
        assertEquals(1, rig.phone.frames.latest()!!.id)
        assertTrue("sensitive asks nothing for a plain tap", rig.asked.isEmpty())
    }

    @Test
    fun `without a screenshot to take, the answer says so`() {
        rig.phone.screen.shot = null
        list(button("Send"))
        val done = rig.call("ui_act", "ref" to "e1", "action" to "tap")
        assertTrue(rig.text(done), rig.text(done).contains("No screenshot was attached"))
        assertEquals(1, done.getJSONArray("content").length())
    }

    @Test
    fun `with the screen switch off no screenshot is attached`() {
        rig.withScreenshot()
        list(button("Send"))
        rig.phone.grant("control")
        val done = rig.call("ui_act", "ref" to "e1", "action" to "tap")
        assertFalse(rig.isError(done))
        assertTrue(rig.text(done), rig.text(done).contains("screen switch is off"))
        assertEquals(1, done.getJSONArray("content").length())
        assertNull(rig.phone.frames.latest())
    }

    private fun assertNull(value: Any?) = org.junit.Assert.assertNull(value)

    @Test
    fun `a tap on text inside a clickable row clicks the row, and a click that does nothing falls back to a touch`() {
        val child = label("Child", Bounds(10, 10, 110, 50))
        val row = button("Row", Bounds(0, 0, 400, 100)).add(child)
        list(row)
        assertFalse(rig.isError(rig.call("ui_act", "ref" to "e2", "action" to "tap")))
        assertEquals(listOf("click"), row.performed)
        assertTrue(child.performed.isEmpty())

        val stubborn = button("Stubborn", Bounds(100, 200, 300, 280)).also { it.clickWorks = false }
        list(stubborn)
        assertFalse(rig.isError(rig.call("ui_act", "ref" to "e1", "action" to "tap")))
        assertEquals(listOf(Triple(200, 240, 60L)), rig.port.touches)
    }

    @Test
    fun `long_press presses and holds`() {
        val item = button("Item").also { it.isLongClickable = true }
        list(item)
        assertEquals("Pressed and held [e1] \"Item\".", rig.text(rig.call("ui_act", "ref" to "e1", "action" to "long_press")))
        assertEquals(listOf("longClick"), item.performed)
    }

    @Test
    fun `it is refused without the control switch, without the service, and for an app the person has not let it act in`() {
        val send = button("Send")
        list(send)
        rig.phone.grant("screen")
        assertTrue(rig.text(rig.call("ui_act", "ref" to "e1", "action" to "tap")).contains("\"Tap, swipe and type\""))
        rig.phone.grant("screen", "control")
        rig.port.isBound = false
        assertTrue(rig.text(rig.call("ui_act", "ref" to "e1", "action" to "tap")).contains("touch service is not switched on"))
        rig.port.isBound = true
        rig.allow("com.app", "App", AppMode.READ)
        val readOnly = rig.text(rig.call("ui_act", "ref" to "e1", "action" to "tap"))
        assertTrue(readOnly, readOnly.contains("look at") && readOnly.contains("mode \"act\""))
        rig.phone.allowList.remove("com.app")
        assertTrue(rig.text(rig.call("ui_act", "ref" to "e1", "action" to "tap")).contains("ask_access"))
        assertTrue(send.performed.isEmpty())
    }

    @Test
    fun `this app, the home screen and Settings are never actable, and a sensitive app needs destructive actions`() {
        val send = button("Send")
        list(send)
        for (pkg in listOf("dev.intentic.device", "com.launcher", "com.android.settings")) {
            rig.allow(pkg, "X", AppMode.ACT)
            rig.port.foreground = Foreground(pkg, "X")
            assertTrue(rig.text(rig.call("ui_act", "ref" to "e1", "action" to "tap")).contains("not offered"))
        }
        rig.port.foreground = Foreground("com.app", "App")
        rig.allow("com.app", "App", AppMode.ACT, sensitive = true)
        assertTrue(rig.text(rig.call("ui_act", "ref" to "e1", "action" to "tap")).contains("Destructive actions"))
        rig.phone.grant("screen", "control", "destructive", confirm = "never")
        assertFalse(rig.isError(rig.call("ui_act", "ref" to "e1", "action" to "tap")))
        assertEquals(listOf("click"), send.performed)
    }

    @Test
    fun `stale and wrong refs are explained`() {
        val send = button("Send")
        assertTrue(rig.text(rig.call("ui_act", "ref" to "e1", "action" to "tap")).contains("call ui_elements first"))
        list(send)
        send.gone = true
        assertTrue(rig.text(rig.call("ui_act", "ref" to "e1", "action" to "tap")).contains("is gone from the screen"))
        send.gone = false
        send.packageName = "com.elsewhere"
        assertTrue(rig.text(rig.call("ui_act", "ref" to "e1", "action" to "tap")).contains("changed to App since that listing"))
        send.packageName = "com.app"
        assertTrue(rig.text(rig.call("ui_act", "ref" to "e7", "action" to "tap")).contains("no element [e7]"))
        assertTrue(send.performed.isEmpty())
    }

    @Test
    fun `a target must be named once and in full`() {
        list(button("Send"))
        assertTrue(rig.text(rig.call("ui_act", "action" to "tap")).contains("Name the target"))
        assertTrue(rig.text(rig.call("ui_act", "action" to "tap", "x" to 5)).contains("both \"x\" and \"y\""))
        assertTrue(rig.text(rig.call("ui_act", "action" to "tap", "ref" to "e1", "x" to 5, "y" to 5)).contains("not both"))
        assertTrue(rig.text(rig.call("ui_act", "action" to "dance", "ref" to "e1")).contains("must be one of"))
    }

    // --- the person's say-so -----------------------------------------------------------------------------------------

    @Test
    fun `always asks before every act, and a no, a Deny or silence means nothing happened`() {
        rig.phone.grant("screen", "control", confirm = "always")
        val send = button("Send")
        list(send)

        rig.answer = false
        val no = rig.call("ui_act", "ref" to "e1", "action" to "tap")
        assertTrue(rig.isError(no))
        assertTrue(rig.text(no), rig.text(no).contains("said no"))
        assertEquals("Your agent wants to tap \"Send\"", rig.asked.single().first)
        assertTrue(rig.asked.single().second.contains("In App"))

        rig.answer = null
        val silent = rig.text(rig.call("ui_act", "ref" to "e1", "action" to "tap"))
        assertTrue(silent, silent.contains("did not answer") && silent.contains("counts as no"))

        rig.paused = true
        assertTrue(rig.text(rig.call("ui_act", "ref" to "e1", "action" to "tap")).contains("paused the agent"))
        rig.paused = false

        assertTrue("nothing was touched without a yes", send.performed.isEmpty())
        rig.answer = true
        assertFalse(rig.isError(rig.call("ui_act", "ref" to "e1", "action" to "tap")))
        assertEquals(listOf("click"), send.performed)
        assertEquals(4, rig.asked.size)
    }

    @Test
    fun `sensitive asks before paying and before a password, and not before other taps or fields`() {
        val pay = button("Pay now")
        val send = button("Send")
        val password = field("Password", null, password = true)
        val search = field("Search", null)
        list(pay, send, password, search)

        rig.call("ui_act", "ref" to "e2", "action" to "tap")
        assertTrue("an ordinary tap asks nothing", rig.asked.isEmpty())
        rig.call("ui_act", "ref" to "e4", "action" to "type", "text" to "cats")
        assertTrue("an ordinary field asks nothing", rig.asked.isEmpty())

        rig.call("ui_act", "ref" to "e1", "action" to "tap")
        assertEquals("Your agent wants to tap \"Pay now\"", rig.asked.last().first)
        rig.call("ui_act", "ref" to "e3", "action" to "type", "text" to "hunter2")
        assertEquals("Your agent wants to type into \"Password\" (a password field)", rig.asked.last().first)
        assertEquals(2, rig.asked.size)
        assertEquals(listOf("click"), pay.performed)
        assertEquals("hunter2", password.text.toString())
    }

    @Test
    fun `never asks nothing at all`() {
        rig.phone.grant("screen", "control", confirm = "never")
        val pay = button("Pay now")
        list(pay)
        assertFalse(rig.isError(rig.call("ui_act", "ref" to "e1", "action" to "tap")))
        assertTrue(rig.asked.isEmpty())
    }

    @Test
    fun `an app marked sensitive asks before every act once the person allowed acting in it`() {
        rig.phone.grant("screen", "control", "destructive")
        rig.allow("com.app", "App", AppMode.ACT, sensitive = true)
        val menu = button("Menu")
        list(menu)
        rig.call("ui_act", "ref" to "e1", "action" to "tap")
        assertEquals(1, rig.asked.size)
        assertTrue(rig.asked.single().first, rig.asked.single().first.contains("tap \"Menu\""))
    }

    @Test
    fun `a tap at a point asks while a password field has the keyboard, since the keys could be typing it`() {
        rig.withScreenshot()
        rig.call("screenshot")
        rig.port.tree = screenOf(label("Keyboard"))
        rig.port.focused = field("Password", null, password = true)
        rig.call("ui_act", "action" to "tap", "x" to 100, "y" to 100)
        assertEquals(1, rig.asked.size)
        assertTrue(rig.asked.single().first, rig.asked.single().first.contains("password field is waiting"))
    }

    @Test
    fun `the screen moving on while the person decides cancels the act`() {
        rig.phone.grant("screen", "control", confirm = "always")
        val send = button("Send")
        list(send)
        rig.port.onWaiting = { rig.port.foreground = Foreground("com.other", "Other") }
        val said = rig.text(rig.call("ui_act", "ref" to "e1", "action" to "tap"))
        assertTrue(said, said.contains("changed to Other while waiting"))
        assertTrue(send.performed.isEmpty())
    }

    // --- text ------------------------------------------------------------------------------------------------------

    @Test
    fun `type adds to a field, set_text replaces it, clear empties it`() {
        val search = field("Search", "ab")
        list(search)
        assertEquals("Typed 2 characters into [e1] \"Search\".", rig.text(rig.call("ui_act", "ref" to "e1", "action" to "type", "text" to "cd")))
        assertEquals("abcd", search.text.toString())
        assertEquals(listOf("focus", "setText:abcd"), search.performed)
        assertEquals("Set the text of [e1] \"Search\".", rig.text(rig.call("ui_act", "ref" to "e1", "action" to "set_text", "text" to "xyz")))
        assertEquals("xyz", search.text.toString())
        assertEquals("Cleared [e1] \"Search\".", rig.text(rig.call("ui_act", "ref" to "e1", "action" to "clear")))
        assertEquals("", search.text.toString())
    }

    @Test
    fun `type ignores a placeholder`() {
        val search = field(null, "Search here").also { it.isShowingHint = true }
        list(search)
        rig.call("ui_act", "ref" to "e1", "action" to "type", "text" to "q")
        assertEquals("q", search.text.toString())
    }

    @Test
    fun `a password field that has something in it cannot be added to, only replaced`() {
        rig.phone.grant("screen", "control", confirm = "never")
        val password = field("Password", "••••", password = true)
        list(password)
        val said = rig.text(rig.call("ui_act", "ref" to "e1", "action" to "type", "text" to "x"))
        assertTrue(said, said.contains("set_text to replace it"))
        assertFalse(rig.isError(rig.call("ui_act", "ref" to "e1", "action" to "set_text", "text" to "new-secret")))
        assertEquals("new-secret", password.text.toString())
    }

    @Test
    fun `text actions need a text field, and text`() {
        list(button("Send"), field("Search", ""))
        assertTrue(rig.text(rig.call("ui_act", "ref" to "e1", "action" to "type", "text" to "x")).contains("not a text field"))
        assertTrue(rig.text(rig.call("ui_act", "ref" to "e2", "action" to "type")).contains("\"text\" is what type puts"))
        assertTrue(rig.text(rig.call("ui_act", "ref" to "e2", "action" to "type", "text" to "")).contains("nothing to type"))
        val stubborn = field("Odd", "").also { it.setTextWorks = false }
        list(stubborn)
        assertTrue(rig.text(rig.call("ui_act", "ref" to "e1", "action" to "set_text", "text" to "x")).contains("would not put text"))
    }

    @Test
    fun `with no target, text goes to the field that has the keyboard`() {
        val search = field("Search", "a")
        rig.port.tree = screenOf(search)
        assertTrue(rig.text(rig.call("ui_act", "action" to "type", "text" to "b")).contains("No field has the keyboard"))
        rig.port.focused = search
        assertFalse(rig.isError(rig.call("ui_act", "action" to "type", "text" to "b")))
        assertEquals("ab", search.text.toString())
    }

    // --- coordinates -------------------------------------------------------------------------------------------------

    @Test
    fun `a point is read in the newest screenshot and mapped to phone pixels`() {
        rig.port.tree = screenOf(label("Nothing"))
        val before = rig.text(rig.call("ui_act", "action" to "tap", "x" to 352, "y" to 784))
        assertTrue(before, before.contains("no screenshot yet"))

        rig.withScreenshot()
        rig.call("screenshot")
        val done = rig.call("ui_act", "action" to "tap", "x" to 352, "y" to 784, "frame" to "f1")
        assertFalse(rig.text(done), rig.isError(done))
        assertEquals(listOf(Triple(540, 1200, 60L)), rig.port.touches)
        assertEquals("Tapped at (540, 1200) in f1.", rig.text(done))
        // The act took a new frame, so the one the agent read the point in is out of date now.
        val stale = rig.text(rig.call("ui_act", "action" to "tap", "x" to 1, "y" to 1, "frame" to "f1"))
        assertTrue(stale, stale.contains("out of date") && stale.contains("f2"))
    }

    @Test
    fun `a point outside the frame, or in a frame of a screen that turned since, is refused`() {
        rig.port.tree = screenOf(label("Nothing"))
        rig.withScreenshot()
        rig.call("screenshot")
        assertTrue(rig.text(rig.call("ui_act", "action" to "tap", "x" to 705, "y" to 0)).contains("outside frame f1"))
        rig.port.size = dev.intentic.device.tools.FrameMath.Size(2400, 1080)
        assertTrue(rig.text(rig.call("ui_act", "action" to "tap", "x" to 5, "y" to 5)).contains("turned or changed"))
        assertTrue(rig.port.touches.isEmpty())
    }

    @Test
    fun `a tap at a point on something risky asks first`() {
        rig.withScreenshot()
        rig.call("screenshot")
        // The element at (540, 1200) of the phone is a Pay button.
        rig.port.tree = screenOf(button("Pay now", Bounds(400, 1100, 700, 1300)))
        rig.call("ui_act", "action" to "tap", "x" to 352, "y" to 784)
        assertEquals("Your agent wants to tap \"Pay now\"", rig.asked.single().first)
    }

    // --- scrolling ---------------------------------------------------------------------------------------------------

    @Test
    fun `scroll uses the node's own scrolling, and a swipe across it when the node will not scroll`() {
        val area = node {
            className = "androidx.recyclerview.widget.RecyclerView"
            isScrollable = true
            bounds = Bounds(0, 0, 1080, 2000)
        }
        list(area)
        assertEquals("Scrolled (down) in [e1].", rig.text(rig.call("ui_act", "ref" to "e1", "action" to "scroll_down")))
        assertEquals(listOf("scroll:DOWN"), area.performed)
        assertTrue(rig.port.swipes.isEmpty())

        area.scrollWorks = false
        rig.call("ui_act", "ref" to "e1", "action" to "scroll_down")
        rig.call("ui_act", "ref" to "e1", "action" to "scroll_up")
        rig.call("ui_act", "ref" to "e1", "action" to "scroll_right")
        assertEquals(
            listOf(listOf(540, 1600, 540, 400, 300), listOf(540, 400, 540, 1600, 300), listOf(864, 1000, 216, 1000, 300)),
            rig.port.swipes,
        )
    }

    @Test
    fun `scroll with no target scrolls the biggest scrolling area on screen`() {
        val small = node { isScrollable = true; bounds = Bounds(0, 0, 100, 100) }
        val big = node { isScrollable = true; bounds = Bounds(0, 0, 1000, 1000) }
        rig.port.tree = screenOf(small, big)
        assertFalse(rig.isError(rig.call("ui_act", "action" to "scroll_down")))
        assertEquals(listOf("scroll:DOWN"), big.performed)
        assertTrue(small.performed.isEmpty())
    }

    @Test
    fun `focus moves the focus to a field`() {
        val search = field("Search", "")
        list(search)
        assertEquals("Focused [e1] \"Search\".", rig.text(rig.call("ui_act", "ref" to "e1", "action" to "focus")))
        assertTrue(search.isFocused)
    }
}

class DeviceToolTest {
    private val rig = TouchRig()

    @Test
    fun `navigation needs the service and the control switch, and no app on the list`() {
        rig.port.foreground = Foreground("com.bank", "Bank")
        for (action in listOf("back", "home", "recents", "notifications", "quick_settings")) {
            assertEquals("Pressed $action.", rig.text(rig.call("device", "action" to action)))
        }
        assertEquals(listOf(Nav.BACK, Nav.HOME, Nav.RECENTS, Nav.NOTIFICATIONS, Nav.QUICK_SETTINGS), rig.port.navigations)
        rig.port.isBound = false
        assertTrue(rig.text(rig.call("device", "action" to "home")).contains("touch service is not switched on"))
        rig.port.isBound = true
        rig.phone.grant("screen")
        assertTrue(rig.text(rig.call("device", "action" to "home")).contains("\"Tap, swipe and type\""))
    }

    @Test
    fun `wait waits and settles once, clamped to a tenth of a second and ten seconds`() {
        assertEquals("Waited 250 ms.", rig.text(rig.call("device", "action" to "wait", "ms" to 250)))
        assertEquals(listOf(250L), rig.slept)
        rig.call("device", "action" to "wait")
        rig.call("device", "action" to "wait", "ms" to 5)
        rig.call("device", "action" to "wait", "ms" to 99_999)
        assertEquals(listOf(250L, 1_000L, 100L, 10_000L), rig.slept)
    }

    @Test
    fun `locking the screen and the power menu are not offered, by schema and by refusal`() {
        val tool = DeviceTool(rig.env)
        val offered = tool.inputSchema.getJSONObject("properties").getJSONObject("action").getJSONArray("enum")
        val names = (0 until offered.length()).map { offered.getString(it) }
        assertEquals(listOf("back", "home", "recents", "notifications", "quick_settings", "tap", "swipe", "wait"), names)
        for (forbidden in listOf("lock", "lock_screen", "power", "power_dialog")) {
            val said = rig.text(rig.call("device", "action" to forbidden))
            assertTrue(said, said.contains("must be one of"))
            try {
                tool.call(JSONObject().put("action", forbidden))
                fail("$forbidden was done")
            } catch (refused: ToolRefused) {
                assertTrue(refused.message!!.contains("not offered"))
            }
        }
        assertTrue(rig.port.navigations.isEmpty() && rig.port.touches.isEmpty())
    }

    @Test
    fun `a tap and a swipe are read in the newest screenshot and need an app the person allowed acting in`() {
        rig.port.tree = screenOf(label("Nothing"))
        rig.withScreenshot()
        rig.call("screenshot")
        assertEquals("Tapped at (540, 1200) in f1.", rig.text(rig.call("device", "action" to "tap", "x" to 352, "y" to 784)))
        assertEquals(listOf(Triple(540, 1200, 60L)), rig.port.touches)
        val swipe = rig.text(rig.call("device", "action" to "swipe", "x" to 352, "y" to 1000, "to" to org.json.JSONArray(listOf(352, 200)), "frame" to "f2"))
        assertTrue(swipe, swipe.startsWith("Swiped from (540, 1531) to (540, 306) in f2."))
        assertEquals(listOf(540, 1531, 540, 306, 300), rig.port.swipes.single())

        rig.port.foreground = Foreground("com.bank", "Bank")
        assertTrue(rig.text(rig.call("device", "action" to "tap", "x" to 1, "y" to 1)).contains("ask_access"))
        assertEquals(1, rig.port.touches.size)
    }

    @Test
    fun `a swipe needs where it ends, and a tap needs a point`() {
        rig.withScreenshot()
        rig.call("screenshot")
        assertTrue(rig.text(rig.call("device", "action" to "swipe", "x" to 1, "y" to 1)).contains("needs \"to\""))
        assertTrue(rig.text(rig.call("device", "action" to "tap")).contains("needs \"x\" and \"y\""))
        assertTrue(rig.text(rig.call("device", "action" to "swipe", "x" to 1, "y" to 1, "to" to org.json.JSONArray(listOf(1)))).contains("exactly 2 items"))
    }

    @Test
    fun `a gesture Android refuses is reported`() {
        rig.port.tree = screenOf(label("Nothing"))
        rig.withScreenshot()
        rig.call("screenshot")
        rig.port.gesturesWork = false
        assertTrue(rig.text(rig.call("device", "action" to "tap", "x" to 5, "y" to 5)).contains("would not make that touch"))
        rig.port.navigationWorks = false
        assertTrue(rig.text(rig.call("device", "action" to "back")).contains("would not do \"back\""))
    }

    @Test
    fun `a swipe by an app marked sensitive asks first`() {
        rig.phone.grant("screen", "control", "destructive")
        rig.allow("com.app", "App", AppMode.ACT, sensitive = true)
        rig.port.tree = screenOf(label("Nothing"))
        rig.withScreenshot()
        rig.call("screenshot")
        rig.call("device", "action" to "swipe", "x" to 1, "y" to 1, "to" to org.json.JSONArray(listOf(10, 10)))
        assertEquals("Your agent wants to swipe the screen (App is marked sensitive)", rig.asked.single().first)
    }

    @Test
    fun `the three tools are listed whatever the switches say, as destructive-capable, and ui_elements as read-only`() {
        rig.phone.grant()
        val tools = rig.phone.mcpCall("tools/list").getJSONObject("result").getJSONArray("tools")
        val byName = (0 until tools.length()).associate { tools.getJSONObject(it).getString("name") to tools.getJSONObject(it) }
        assertTrue(byName.keys.containsAll(listOf("ui_elements", "ui_act", "device")))
        assertTrue(byName.getValue("ui_elements").getJSONObject("annotations").getBoolean("readOnlyHint"))
        assertTrue(byName.getValue("ui_act").getJSONObject("annotations").getBoolean("destructiveHint"))
        assertNotEquals(byName.getValue("ui_act").getString("description"), byName.getValue("device").getString("description"))
        assertEquals(setOf("ref", "x", "y", "frame", "action", "text"), byName.getValue("ui_act").getJSONObject("inputSchema").getJSONObject("properties").keys().asSequence().toSet())
    }
}
