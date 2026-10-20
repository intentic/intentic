package dev.intentic.app.conversation

import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import androidx.recyclerview.widget.RecyclerView
import dev.intentic.app.R
import dev.intentic.app.core.Spans
import dev.intentic.app.ui.Ui

/**
 * The conversation's rows as RecyclerView items. [count] is what the list has been told (RowCount), never what the
 * core holds by now. A drawn row is a [RowView]; a card or a page adds its buttons under the text; the one row being
 * selected is a [SelectableRow] until its copy toolbar closes.
 */
class TranscriptAdapter(
    private val cache: () -> RowCache,
    private val look: RowLook,
    private val ui: Ui,
    actions: CardActions,
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    private val buttons = CardButtons(ui, actions)
    private val side = look.dp(SIDE)
    var count = 0
    private var selecting = RecyclerView.NO_POSITION
    private var touchX = 0f
    private var touchY = 0f

    class Holder(view: View) : RecyclerView.ViewHolder(view)

    override fun getItemCount(): Int = count

    override fun getItemViewType(position: Int): Int =
        when {
            position == selecting -> SELECTING
            cache().get(position).kind.let { it == Spans.VIEW_CARD || it == Spans.VIEW_PAGE } -> CARD
            else -> TEXT
        }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val view: View = when (viewType) {
            SELECTING -> SelectableRow(parent.context, look) { unselect() }
            CARD -> LinearLayout(parent.context).apply {
                orientation = LinearLayout.VERTICAL
                background = ui.surface(R.color.card, radius = 12, stroke = R.color.line)
                val inset = look.dp(RowCache.CARD_PADDING)
                setPadding(inset, look.dp(4f), inset, inset)
                addView(RowView(parent.context, look, bubbled = false))
                addView(LinearLayout(parent.context).apply { orientation = LinearLayout.VERTICAL })
            }
            else -> RowView(parent.context, look).apply { setPadding(side, 0, side, 0) }
        }
        view.layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            if (viewType == CARD) setMargins(side, look.dp(RowView.GAP), side, look.dp(RowView.GAP))
        }
        val holder = Holder(view)
        // Long press, set once per holder: the row under the finger becomes selectable text.
        val drawn = (view as? RowView) ?: ((view as? LinearLayout)?.getChildAt(0) as? RowView)
        drawn?.setOnLongClickListener {
            select(holder.bindingAdapterPosition, drawn.touchX + (if (view === drawn) 0 else view.paddingLeft), drawn.touchY)
            true
        }
        return holder
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        val row = cache().get(position)
        when (val view = holder.itemView) {
            is SelectableRow -> view.bind(row, side, touchX, touchY)
            is RowView -> view.row = row
            is LinearLayout -> {
                (view.getChildAt(0) as RowView).row = row
                buttons.fill(view.getChildAt(1) as LinearLayout, row.card, page = row.kind == Spans.VIEW_PAGE, pageId = row.pageId)
            }
        }
        cache().buildAhead(position - AHEAD, position + AHEAD)
    }

    private fun select(position: Int, x: Float, y: Float) {
        if (position == RecyclerView.NO_POSITION) return
        unselect()
        selecting = position
        touchX = x
        touchY = y
        notifyItemChanged(position)
    }

    /** Back to the drawn row, once the copy toolbar is gone. */
    fun unselect() {
        val was = selecting
        selecting = RecyclerView.NO_POSITION
        if (was != RecyclerView.NO_POSITION && was < count) notifyItemChanged(was)
    }

    /** A structural change moves the selected row with the rest, or ends the selection. */
    fun shifted(notice: Notice) {
        if (selecting == RecyclerView.NO_POSITION) return
        selecting = when (notice) {
            is Notice.Inserted -> if (notice.at <= selecting) selecting + notice.count else selecting
            is Notice.Removed -> if (selecting in notice.at until notice.at + notice.count) RecyclerView.NO_POSITION
                else if (notice.at < selecting) selecting - notice.count else selecting
            is Notice.All -> RecyclerView.NO_POSITION
            is Notice.Changed -> selecting
        }
    }

    companion object {
        const val SIDE = 16f
        /** How many rows either side of a bound one are laid out ahead of the scroll. */
        const val AHEAD = 12
        private const val TEXT = 0
        private const val CARD = 1
        private const val SELECTING = 2
    }
}
