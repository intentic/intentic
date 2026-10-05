package dev.intentic.device.touch

import dev.intentic.device.tools.FrameMath
import dev.intentic.device.tools.ToolFailed
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ElementsTest {
    private fun list(root: UiNode) = Elements.list(root, 1080, 2400)

    private fun sampleScreen(): FakeNode {
        val hidden = label("hidden text").also { it.isVisibleToUser = false }
        val empty = label("zero size", Bounds(10, 10, 10, 10))
        val logo = node { className = "android.widget.ImageView"; contentDescription = "Logo"; bounds = Bounds(0, 0, 100, 100) }
        return screenOf(
            label("Welcome back", Bounds(0, 0, 1080, 100)),
            button("Send", Bounds(100, 200, 300, 280)),
            field("Search", "cats", Bounds(0, 300, 1080, 380)),
            field("Password", "secret123", Bounds(0, 400, 1080, 480), password = true),
            hidden,
            empty,
            logo,
        )
    }

    @Test
    fun `a screen becomes a numbered list in reading order, without what is hidden or empty`() {
        val listing = list(sampleScreen())
        assertEquals(listOf("e1", "e2", "e3", "e4", "e5"), listing.elements.map { it.ref })
        assertEquals(listOf("text", "button", "text field", "password field", "image"), listing.elements.map { it.role })
        assertEquals(listOf("Welcome back", "Send", "Search", "Password", "Logo"), listing.elements.map { it.label })
        assertEquals(5, listing.total)
        assertFalse(listing.incomplete)
    }

    @Test
    fun `a field is named by its hint and holds its text, and a password field never shows its content`() {
        val listing = list(sampleScreen())
        val search = listing.elements[2]
        assertEquals("cats", search.value)
        val password = listing.elements[3]
        assertNull(password.value)
        assertTrue(password.password)
        assertTrue(password.flags.contains("filled"))
        val shown = Elements.format(listing, "App", null)
        assertFalse(shown, shown.contains("secret123"))
        assertTrue(shown, shown.contains("[e3] text field \"Search\" = \"cats\""))
        assertTrue(shown, shown.contains("[e4] password field \"Password\""))
    }

    @Test
    fun `a field showing its placeholder has no value`() {
        val placeholder = field(null, "Search here", Bounds(0, 0, 400, 80)).also { it.isShowingHint = true }
        val listing = list(screenOf(placeholder))
        assertEquals("Search here", listing.elements.single().label)
        assertNull(listing.elements.single().value)
    }

    @Test
    fun `a control with no text of its own is called by the text inside it, which is not listed twice`() {
        val row = node {
            className = "android.view.ViewGroup"
            isClickable = true
            bounds = Bounds(0, 500, 1080, 600)
        }.add(label("Pay", Bounds(0, 500, 200, 600)), label("now", Bounds(200, 500, 400, 600)))
        val listing = list(screenOf(row))
        assertEquals(1, listing.elements.size)
        assertEquals("Pay now", listing.elements.single().label)
        assertEquals("control", listing.elements.single().role)
        assertEquals(listOf("clickable"), listing.elements.single().flags)
    }

    @Test
    fun `an operable control inside such a row is still listed, and is not part of the row's name`() {
        val toggle = node { className = "android.widget.Switch"; isCheckable = true; isChecked = true; isClickable = true; text = "Wi-Fi"; bounds = Bounds(800, 500, 1000, 600) }
        val row = node { isClickable = true; bounds = Bounds(0, 500, 1080, 600) }.add(label("Network", Bounds(0, 500, 200, 600)), toggle)
        val listing = list(screenOf(row))
        assertEquals(listOf("Network", "Wi-Fi"), listing.elements.map { it.label })
        assertEquals(listOf("control", "switch"), listing.elements.map { it.role })
        assertTrue(listing.elements[1].flags.containsAll(listOf("checked", "clickable")))
    }

    @Test
    fun `flags say what state a node is in`() {
        val dimmed = button("Later").also { it.isEnabled = false; it.isFocused = true; it.isLongClickable = true }
        val flags = list(screenOf(dimmed)).elements.single().flags
        assertEquals(listOf("clickable", "long-clickable", "focused", "disabled"), flags)
    }

    @Test
    fun `refs name the newest listing only`() {
        val refs = RefTable()
        try {
            refs.resolve("e1")
            fail("no listing yet")
        } catch (refused: ToolFailed) {
            assertTrue(refused.message!!.contains("call ui_elements first"))
        }
        val first = list(sampleScreen())
        refs.store(first)
        assertSame(first.elements[1], refs.resolve("e2"))
        assertSame(first.elements[1], refs.resolve("[e2]"))
        assertSame(first.elements[1], refs.resolve(" E2 "))
        try {
            refs.resolve("e9")
            fail("e9 is not there")
        } catch (refused: ToolFailed) {
            assertTrue(refused.message!!, refused.message!!.contains("[e1] to [e5]") && refused.message!!.contains("Call ui_elements again"))
        }
        refs.store(list(screenOf(button("Only"))))
        try {
            refs.resolve("e2")
            fail("the old listing is gone")
        } catch (refused: ToolFailed) {
            assertTrue(refused.message!!.contains("[e1] to [e1]"))
        }
    }

    @Test
    fun `a listing is cut at 250 elements and says so`() {
        val many = (1..300).map { label("Row $it", Bounds(0, it, 100, it + 1)) }
        val listing = list(screenOf(*many.toTypedArray()))
        assertEquals(250, listing.elements.size)
        assertEquals(300, listing.total)
        assertTrue(listing.incomplete)
        assertTrue(Elements.format(listing, "App", null).contains("the first 250 shown"))
    }

    @Test
    fun `the smallest element at a point wins, so a button beats the list it sits in`() {
        val list = node { isScrollable = true; className = "androidx.recyclerview.widget.RecyclerView"; bounds = Bounds(0, 0, 1080, 2000) }
            .add(button("Open", Bounds(100, 100, 300, 180)))
        val listing = list(screenOf(list))
        assertEquals("Open", Elements.hitTest(listing, 150, 120)?.label)
        assertEquals("scrolling area", Elements.hitTest(listing, 900, 1500)?.role)
        assertNull(Elements.hitTest(listing, 900, 2300))
    }

    @Test
    fun `positions are in the frame when it shows this screen, and in phone pixels when not`() {
        val listing = list(screenOf(button("Send", Bounds(100, 200, 300, 280))))
        val frame = FrameMath.Frame(3, 540, 1200, 1080, 2400)
        val inFrame = Elements.format(listing, "App", frame)
        assertTrue(inFrame, inFrame.contains("Positions are pixels in f3.") && inFrame.contains("at 50,100 100x40"))
        val noFrame = Elements.format(listing, "App", null)
        assertTrue(noFrame, noFrame.contains("phone pixels (1080x2400)") && noFrame.contains("at 100,200 200x80"))
        val turned = Elements.format(listing, "App", FrameMath.Frame(4, 1200, 540, 2400, 1080))
        assertTrue(turned, turned.contains("phone pixels"))
    }

    @Test
    fun `a screen with nothing to read says to use a screenshot`() {
        val listing = list(screenOf())
        assertTrue(Elements.format(listing, "App", null).contains("use a screenshot and coordinates"))
    }

    @Test
    fun `long text is cut`() {
        val listing = list(screenOf(label("w".repeat(200))))
        assertEquals(83, listing.elements.single().label.length)
        assertTrue(listing.elements.single().label.endsWith("..."))
    }
}
