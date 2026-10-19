package dev.intentic.spike.compose

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class TranscriptTest {
    private val fixture = File(System.getProperty("spike.fixture")!!).readText()

    @Test
    fun inflatesToTheExactCountWithAdditionsOnEvenCopies() {
        val parsed = Fixture.parse(fixture)
        val rows = parsed.inflate(2000)
        assertEquals(2000, rows.size)
        assertEquals(24, parsed.stream.chunk)
        // Row 1 is the first answer: copy 0 gains the addition, copy 1 (row 10) does not, copy 2 (row 19) does.
        assertTrue(rows[1].text.contains("What changed in step 0:"))
        assertFalse(rows[10].text.contains("What changed"))
        assertTrue(rows[19].text.contains("What changed in step 2:"))
        assertEquals(Role.User, rows[0].role)
        assertEquals((0 until 2000).toList(), rows.map { it.id })
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesAFixtureWithNoRows() {
        val empty = """{"addition":"","stream":{"prose":"","chunk":1,"everyMs":1,"tools":[],"toolMs":1,"gapMs":1},"rows":[]}"""
        Fixture.parse(empty).inflate(10)
    }
}
