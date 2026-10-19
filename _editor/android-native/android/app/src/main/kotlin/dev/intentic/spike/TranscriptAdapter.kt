package dev.intentic.spike

import android.os.Trace
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView

/** The transcript's rows as RecyclerView items. [count] is what the list has been told of, not what the core holds. */
class TranscriptAdapter(private val rows: Rows, private val look: Look, var count: Int) : RecyclerView.Adapter<TranscriptAdapter.Holder>() {
    class Holder(val view: RowView) : RecyclerView.ViewHolder(view)

    init {
        setHasStableIds(true)
    }

    override fun getItemCount(): Int = count

    // Rows are only ever appended, so a row's position is its identity.
    override fun getItemId(position: Int): Long = position.toLong()

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        val view = RowView(parent.context, look)
        view.layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        val side = look.dp(SIDE)
        view.setPadding(side, 0, side, 0)
        return Holder(view)
    }

    override fun onBindViewHolder(holder: Holder, position: Int) {
        Trace.beginSection("spike.bind")
        holder.view.row = rows.latest(position) ?: rows.build(position)
        rows.buildAhead((position - AHEAD).coerceAtLeast(0) until (position + AHEAD).coerceAtMost(count))
        Trace.endSection()
    }

    companion object {
        const val SIDE = 16f
        /** How many rows either side of a bound one are laid out ahead of the scroll. */
        const val AHEAD = 12
    }
}
