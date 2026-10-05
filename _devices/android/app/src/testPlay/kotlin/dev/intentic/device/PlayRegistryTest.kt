package dev.intentic.device

import dev.intentic.device.tools.Registry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The store build carries no way to read or touch other apps' screens: not a switch that is off, but code that is not there. */
class PlayRegistryTest {
    private val touchTools = listOf("ui_elements", "ui_act", "device")

    @Test
    fun `the play build lists the common tools and none of the three touch tools`() {
        val phone = FakePhone()
        val listed = Registry.tools(phone.deps, Distribution.tools(phone.deps)).map { it.name }
        assertEquals(
            listOf("describe", "screenshot", "open", "apps", "ask_access", "list_dir", "read_file", "write_file", "trash_file", "clipboard", "notifications"),
            listed,
        )
        for (tool in touchTools) {
            assertFalse("$tool must not be listed in the play build", tool in listed)
        }
        assertTrue(Distribution.tools(phone.deps).isEmpty())
    }

    @Test
    fun `the play build reports no accessibility, no touch feature, and screenshots through the person-approved session`() {
        assertFalse(Distribution.accessibilityBound())
        assertTrue(Distribution.features.isEmpty())
        val phone = FakePhone()
        assertSame(phone.screen, Distribution.screen(phone.screen))
        assertEquals(false, phone.call("describe").getJSONObject("result").getJSONObject("access").getBoolean("accessibility"))
    }

    @Test
    fun `the touch service's code is not in the play build at all`() {
        for (name in listOf("dev.intentic.device.touch.TouchService", "dev.intentic.device.touch.UiActTool", "dev.intentic.device.touch.NodeAdapter")) {
            try {
                Class.forName(name)
                fail("$name is in the play build")
            } catch (absent: ClassNotFoundException) {
                // As it should be.
            }
        }
    }

    @Test
    fun `the play build has no updater`() {
        assertEquals(null, Distribution.updates)
    }
}
