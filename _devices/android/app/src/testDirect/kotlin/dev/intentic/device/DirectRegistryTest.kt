package dev.intentic.device

import dev.intentic.device.tools.Registry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DirectRegistryTest {
    @Test
    fun `the direct build lists the common tools and then ui_elements, ui_act and device`() {
        val phone = FakePhone()
        val listed = Registry.tools(phone.deps, Distribution.tools(phone.deps)).map { it.name }
        assertEquals(
            listOf(
                "describe", "screenshot", "open", "apps", "ask_access", "list_dir", "read_file", "write_file", "trash_file", "clipboard", "notifications",
                "ui_elements", "ui_act", "device",
            ),
            listed,
        )
    }

    @Test
    fun `the direct build reports the touch feature, no bound service until the person switches it on, and an updater`() {
        assertEquals(listOf("touch"), Distribution.features)
        assertFalse(Distribution.accessibilityBound())
        assertNotNull(Distribution.updates)
        assertTrue(Distribution.updates!!.status().isNotEmpty())
    }
}
