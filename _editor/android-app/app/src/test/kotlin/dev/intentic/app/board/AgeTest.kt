package dev.intentic.app.board

import org.junit.Assert.assertEquals
import org.junit.Test

class AgeTest {
    private val now = 1_760_900_000_000L
    private fun ago(ms: Long) = ageOf((now - ms).toDouble(), now)

    @Test
    fun underAMinuteIsNowAndAClockAheadIsNowToo() {
        assertEquals(Age.Now, ago(0))
        assertEquals(Age.Now, ago(59_999))
        assertEquals(Age.Now, ago(-5_000))
    }

    @Test
    fun eachUnitIsRoundedDown() {
        assertEquals(Age.Minutes(1), ago(60_000))
        assertEquals(Age.Minutes(2), ago(179_999))
        assertEquals(Age.Minutes(59), ago(3_599_999))
        assertEquals(Age.Hours(1), ago(3_600_000))
        assertEquals(Age.Hours(23), ago(86_399_999))
        assertEquals(Age.Days(1), ago(86_400_000))
        assertEquals(Age.Days(6), ago(7 * 86_400_000L - 1))
    }

    @Test
    fun aWeekOrMoreIsTheCalendarDay() {
        val at = now - 7 * 86_400_000L
        assertEquals(Age.On(at), ageOf(at.toDouble(), now))
    }
}
