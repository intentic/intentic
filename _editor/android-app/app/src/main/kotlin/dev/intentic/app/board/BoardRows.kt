package dev.intentic.app.board

import dev.intentic.app.core.BoardCard
import dev.intentic.app.core.BoardLane

/** One row of the board's list: a lane's heading, or a card under it. */
sealed interface BoardRow {
    data class Lane(val lane: BoardLane, val count: Int) : BoardRow

    data class Card(val card: BoardCard) : BoardRow
}

// The web board's order (boardLanes.ts): what needs the person, then what is running, then what is done.
private val LANES = listOf(BoardLane.Attention, BoardLane.Active, BoardLane.Finished)

/**
 * The board as the list draws it: each lane that has a card, under its heading, its cards in the core's order (newest
 * activity first). Subagents are left off for now: the web nests them under their parent's card, which is phase 2's.
 */
fun boardRows(cards: List<BoardCard>): List<BoardRow> {
    val top = cards.filter { it.parent == null }
    return LANES.flatMap { lane ->
        val inLane = top.filter { it.lane == lane }
        if (inLane.isEmpty()) emptyList() else listOf(BoardRow.Lane(lane, inLane.size)) + inLane.map(BoardRow::Card)
    }
}
