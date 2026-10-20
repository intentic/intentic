package dev.intentic.app.board

import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import dev.intentic.app.R
import dev.intentic.app.core.BoardCard
import dev.intentic.app.core.BoardLane
import dev.intentic.app.ui.Ui

/** The board's rows. The diff runs off the main thread (ListAdapter), so a whole-board event costs a frame nothing. */
class BoardAdapter(private val ui: Ui, private val open: (BoardCard) -> Unit) : ListAdapter<BoardRow, BoardAdapter.Holder>(SAME) {
    private val ages = AgeText(ui.context)
    private var now = System.currentTimeMillis()

    class Holder(view: View) : RecyclerView.ViewHolder(view)

    /** Moves every card's age on to [at], without rebuilding a row. */
    fun tick(at: Long) {
        now = at
        notifyItemRangeChanged(0, itemCount, AGE)
    }

    override fun getItemViewType(position: Int): Int = if (getItem(position) is BoardRow.Lane) LANE else CARD

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
        Holder(
            if (viewType == LANE) {
                ui.text("", 13f, 600, R.color.muted).apply {
                    setPadding(ui.dp(20), ui.dp(18), ui.dp(20), ui.dp(6))
                    androidx.core.view.ViewCompat.setAccessibilityHeading(this, true)
                    layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
                }
            } else {
                AgentCard(ui).apply {
                    layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT).apply {
                        setMargins(ui.dp(12), ui.dp(4), ui.dp(12), ui.dp(4))
                    }
                }
            },
        )

    override fun onBindViewHolder(holder: Holder, position: Int) {
        when (val row = getItem(position)) {
            is BoardRow.Lane -> (holder.itemView as TextView).text = "${ui.context.getString(labelOf(row.lane))}  ${row.count}"
            is BoardRow.Card -> {
                (holder.itemView as AgentCard).bind(row.card, ages, now)
                holder.itemView.setOnClickListener { open(row.card) }
            }
        }
    }

    private companion object {
        const val LANE = 0
        const val CARD = 1
        val AGE = Any()

        // The lane names the web board shows (boardLanes.ts).
        fun labelOf(lane: BoardLane): Int =
            when (lane) {
                BoardLane.Attention -> R.string.shared_attention
                BoardLane.Active -> R.string.shared_active
                BoardLane.Finished -> R.string.shared_finished
            }

        val SAME = object : DiffUtil.ItemCallback<BoardRow>() {
            override fun areItemsTheSame(old: BoardRow, new: BoardRow): Boolean =
                (old is BoardRow.Lane && new is BoardRow.Lane && old.lane == new.lane) ||
                    (old is BoardRow.Card && new is BoardRow.Card && old.card.id == new.card.id)

            override fun areContentsTheSame(old: BoardRow, new: BoardRow): Boolean = old == new
        }
    }
}
