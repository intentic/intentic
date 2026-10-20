package dev.intentic.app.conversation

import dev.intentic.app.core.EventRowsInner
import dev.intentic.app.core.RowChange
import dev.intentic.app.core.RowChangeChangedInner
import dev.intentic.app.core.RowChangeInsertedInner
import dev.intentic.app.core.RowChangeRemovedInner
import org.junit.Assert.assertEquals
import org.junit.Test

class RowCountTest {
    private val rows = RowCount()

    private fun event(count: Int, change: RowChange) = EventRowsInner(agent = "a", count = count.toUInt(), change = change, live = false, more = false)
    private fun inserted(at: Int, count: Int) = RowChange.Inserted(RowChangeInsertedInner(at.toUInt(), count.toUInt()))
    private fun changed(at: Int, count: Int) = RowChange.Changed(RowChangeChangedInner(at.toUInt(), count.toUInt()))
    private fun removed(at: Int, count: Int) = RowChange.Removed(RowChangeRemovedInner(at.toUInt(), count.toUInt()))

    @Test
    fun eachChangeIsToldInTheAdaptersTermsAndMovesTheCount() {
        assertEquals(Notice.All(40), rows.apply(event(40, RowChange.Reset)))
        assertEquals(Notice.Inserted(40, 2), rows.apply(event(42, inserted(40, 2))))
        assertEquals(Notice.Inserted(0, 30), rows.apply(event(72, inserted(0, 30))))
        assertEquals(Notice.Changed(71, 1), rows.apply(event(72, changed(71, 1))))
        assertEquals(Notice.Removed(70, 1), rows.apply(event(71, removed(70, 1))))
        assertEquals(71, rows.count)
    }

    @Test
    fun aChangeWhoseCountDoesNotAddUpRereadsEverything() {
        rows.apply(event(10, RowChange.Reset))
        assertEquals(Notice.All(13), rows.apply(event(13, inserted(10, 2))))
        assertEquals(Notice.All(13), rows.apply(event(13, changed(12, 5))))
        assertEquals(Notice.All(12), rows.apply(event(12, removed(20, 1))))
        assertEquals(Notice.All(14), rows.apply(event(14, inserted(20, 2))))
        assertEquals(14, rows.count)
    }
}
