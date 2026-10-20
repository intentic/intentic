package dev.intentic.app.conversation

import dev.intentic.app.core.EventRowsInner
import dev.intentic.app.core.RowChange

/** What the list is told about one Event.Rows, in RecyclerView's own terms. */
sealed interface Notice {
    /** Everything: a reset, or a change whose count does not add up (the list then reads every row again). */
    data class All(val count: Int) : Notice

    data class Inserted(val at: Int, val count: Int) : Notice

    data class Changed(val at: Int, val count: Int) : Notice

    data class Removed(val at: Int, val count: Int) : Notice
}

/**
 * The count the list has been told, moved by each Event.Rows exactly as the core says it: a list adapter must be told
 * every change in the order it happened, and its count must agree with each one, or RecyclerView throws.
 */
class RowCount {
    var count = 0
        private set

    fun apply(event: EventRowsInner): Notice {
        val before = count
        val after = event.count.toInt()
        count = after
        val notice = when (val change = event.change) {
            RowChange.Reset -> Notice.All(after)
            is RowChange.Inserted -> Notice.Inserted(change.content.at.toInt(), change.content.count.toInt())
            is RowChange.Changed -> Notice.Changed(change.content.at.toInt(), change.content.count.toInt())
            is RowChange.Removed -> Notice.Removed(change.content.at.toInt(), change.content.count.toInt())
        }
        val adds = when (notice) {
            is Notice.All -> true
            is Notice.Inserted -> notice.at in 0..before && before + notice.count == after
            is Notice.Removed -> notice.at >= 0 && notice.at + notice.count <= before && before - notice.count == after
            is Notice.Changed -> notice.at >= 0 && notice.at + notice.count <= before && before == after
        }
        return if (adds) notice else Notice.All(after)
    }
}
