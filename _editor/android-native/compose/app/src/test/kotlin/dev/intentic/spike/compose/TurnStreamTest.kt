package dev.intentic.spike.compose

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnStreamTest {
    private val spec = StreamSpec(prose = "abcdefghij", chunk = 4, everyMs = 16, tools = listOf("Read", "Bash"), toolMs = 50, gapMs = 30)

    @Test
    fun writesAnAnswerThenRunsItsToolsOnTheClock() {
        val rows = mutableListOf<Row>()
        val stream = TurnStream(spec, 1_000, 10_000)
        stream.tick(rows, 1_000)
        assertEquals(TurnStream.PROMPT, rows[0].text)
        assertEquals("the first chunk lands with the empty answer", "abcd", rows[1].text)
        stream.tick(rows, 1_032)
        assertEquals("abcdefghij", rows[1].text)
        // Prose ran out at 1048: Read starts, finishes at 1098, Bash starts after the 30ms gap at 1128.
        stream.tick(rows, 1_100)
        assertEquals(1, rows[1].tools.size)
        assertEquals(ToolStatus.Done, rows[1].tools[0].status)
        stream.tick(rows, 1_128)
        assertEquals(ToolStatus.Running, rows[1].tools[1].status)
        assertEquals(TurnStream.TOOL_TARGET, rows[1].tools[1].summary)
        // Bash ends at 1178, its gap at 1208, and the next answer starts with its first chunk.
        stream.tick(rows, 1_208)
        assertEquals(3, rows.size)
        assertEquals("abcd", rows[2].text)
    }

    @Test
    fun stopsWritingAtTheDeadline() {
        val rows = mutableListOf<Row>()
        val stream = TurnStream(spec, 0, 20)
        assertTrue(stream.tick(rows, 1_000))
        assertEquals("chunks at 0 and 16 only: the one due at 32 is past the deadline", "abcdefgh", rows[1].text)
    }

    @Test
    fun theFixtureTurnEndsWithTheRowCountEveryArmReports() {
        val fixture = Fixture.parse(java.io.File(System.getProperty("spike.fixture")!!).readText())
        val rows = fixture.inflate(2000).toMutableList()
        val stream = TurnStream(fixture.stream, 0, 10_000)
        var now = 0L
        while (!stream.tick(rows, now)) now += 16
        assertEquals(2023, rows.size)
    }
}
