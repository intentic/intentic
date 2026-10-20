package dev.intentic.app.board

import dev.intentic.app.core.BoardCard
import dev.intentic.app.core.BoardLane
import org.junit.Assert.assertEquals
import org.junit.Test

class BoardRowsTest {
    private fun card(id: String, lane: BoardLane, updatedAt: Double, parent: String? = null) =
        BoardCard(id = id, lane = lane, status = "idle", working = false, unread = false, updatedAt = updatedAt, parent = parent)

    @Test
    fun lanesComeInTheWebsOrderEachUnderItsHeadingKeepingTheCoresOrder() {
        val cards = listOf(
            card("f1", BoardLane.Finished, 9.0),
            card("a1", BoardLane.Attention, 8.0),
            card("v1", BoardLane.Active, 7.0),
            card("a2", BoardLane.Attention, 6.0),
        )
        assertEquals(
            listOf(
                BoardRow.Lane(BoardLane.Attention, 2),
                BoardRow.Card(cards[1]),
                BoardRow.Card(cards[3]),
                BoardRow.Lane(BoardLane.Active, 1),
                BoardRow.Card(cards[2]),
                BoardRow.Lane(BoardLane.Finished, 1),
                BoardRow.Card(cards[0]),
            ),
            boardRows(cards),
        )
    }

    @Test
    fun anEmptyLaneHasNoHeading() {
        val only = card("f1", BoardLane.Finished, 1.0)
        assertEquals(listOf(BoardRow.Lane(BoardLane.Finished, 1), BoardRow.Card(only)), boardRows(listOf(only)))
        assertEquals(emptyList<BoardRow>(), boardRows(emptyList()))
    }

    @Test
    fun subagentsAreLeftOffTheTopLevel() {
        val parent = card("p", BoardLane.Active, 2.0)
        val child = card("c", BoardLane.Attention, 3.0, parent = "p")
        assertEquals(listOf(BoardRow.Lane(BoardLane.Active, 1), BoardRow.Card(parent)), boardRows(listOf(child, parent)))
    }
}
