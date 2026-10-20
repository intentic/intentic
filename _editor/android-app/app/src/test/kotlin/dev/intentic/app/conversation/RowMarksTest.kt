package dev.intentic.app.conversation

import dev.intentic.app.core.Spans
import org.junit.Assert.assertEquals
import org.junit.Test

class RowMarksTest {
    private val inks = Inks(content = 1, muted = 2, subtle = 3, accent = 4, link = 5, danger = 6, success = 7)

    private fun marks(vararg quads: Int, length: Int = 100) = marksOf(intArrayOf(Spans.VIEW_ASSISTANT, *quads), 1, length, inks)

    @Test
    fun theViewKindIsSkippedAndEachQuadBecomesItsStyles() {
        assertEquals(listOf(Mark(0, 4, Style.BOLD)), marks(0, 4, Spans.BOLD, 0))
        assertEquals(
            listOf(Mark(2, 9, Style.MONO), Mark(2, 9, Style.BACKGROUND, 0x33808080)),
            marks(2, 9, Spans.CODE, 0x33808080),
        )
        assertEquals(
            listOf(Mark(0, 20, Style.MONO), Mark(0, 20, Style.SCALE, scale = 0.88f), Mark(0, 20, Style.BLOCK, -0xd0c0b)),
            marks(0, 20, Spans.BLOCK, -0xd0c0b),
        )
        assertEquals(listOf(Mark(0, 3, Style.INK, 5), Mark(0, 3, Style.UNDERLINE)), marks(0, 3, Spans.LINK, 0))
        assertEquals(listOf(Mark(0, 3, Style.SCALE, scale = 1.4f), Mark(0, 3, Style.BOLD)), marks(0, 3, Spans.HEADING, 1))
    }

    @Test
    fun aToolLineIsInkedByItsState() {
        assertEquals(4, marks(0, 5, Spans.TOOL, 0).first().value)
        assertEquals(2, marks(0, 5, Spans.TOOL, 1).first().value)
        assertEquals(6, marks(0, 5, Spans.TOOL, 2).first().value)
    }

    @Test
    fun theNewKindsReadAsTheWebDrawsThem() {
        assertEquals(listOf(Mark(0, 5, Style.INK, 2), Mark(0, 5, Style.ITALIC)), marks(0, 5, Spans.THINKING, 0))
        assertEquals(emptyList<Mark>(), marks(0, 5, Spans.TODO, 0))
        assertEquals(listOf(Mark(0, 5, Style.INK, 4)), marks(0, 5, Spans.TODO, 1))
        assertEquals(listOf(Mark(0, 5, Style.INK, 2), Mark(0, 5, Style.STRIKE)), marks(0, 5, Spans.TODO, 2))
        assertEquals(listOf(Mark(0, 5, Style.INK, 2)), marks(0, 5, Spans.MUTED, 0))
        assertEquals(listOf(Mark(0, 5, Style.BOLD)), marks(0, 5, Spans.TITLE, 0))
    }

    @Test
    fun aSpanPastTheTextIsClippedAndAnEmptyOneOrAnUnknownKindIsDropped() {
        assertEquals(listOf(Mark(3, 10, Style.BOLD)), marks(3, 50, Spans.BOLD, 0, length = 10))
        assertEquals(emptyList<Mark>(), marks(12, 20, Spans.BOLD, 0, length = 10))
        assertEquals(emptyList<Mark>(), marks(0, 5, 99, 0))
        assertEquals(emptyList<Mark>(), marks(0, 5, Spans.BOLD))
    }
}
