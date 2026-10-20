package dev.intentic.app.conversation

import android.annotation.SuppressLint
import android.content.Context
import android.os.SystemClock
import android.util.TypedValue
import android.view.ActionMode
import android.view.Gravity
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.widget.FrameLayout
import android.widget.TextView
import dev.intentic.app.core.Spans

/**
 * The stand-in a long press swaps in for a drawn row: a selectable TextView over the same styled text, laid out the
 * same, with the word under the finger already selected and the system's copy toolbar up. When that toolbar goes away
 * the row goes back to being drawn ([done]).
 */
@SuppressLint("ViewConstructor")
class SelectableRow(context: Context, private val look: RowLook, private val done: () -> Unit) : FrameLayout(context) {
    private val text = TextView(context).apply {
        setTextIsSelectable(true)
        typeface = look.sans
        setLineSpacing(0f, RowCache.LINE_SPACING)
        includeFontPadding = false
        customSelectionActionModeCallback = object : ActionMode.Callback {
            override fun onCreateActionMode(mode: ActionMode, menu: Menu) = true

            override fun onPrepareActionMode(mode: ActionMode, menu: Menu) = false

            override fun onActionItemClicked(mode: ActionMode, item: MenuItem) = false

            override fun onDestroyActionMode(mode: ActionMode) {
                post { done() }
            }
        }
    }

    init {
        addView(text)
    }

    fun bind(row: Built, sideways: Int, x: Float, y: Float) {
        val user = row.kind == Spans.VIEW_USER
        val gap = look.dp(RowView.GAP)
        val pad = if (user) look.dp(RowCache.BUBBLE_PADDING) else 0
        text.text = row.text
        text.setTextSize(TypedValue.COMPLEX_UNIT_PX, look.paintFor(row.kind).textSize)
        text.setTextColor(look.paintFor(row.kind).color)
        text.setPadding(pad, pad, pad, pad)
        text.background = if (user) android.graphics.drawable.GradientDrawable().apply {
            setColor(look.bubble)
            cornerRadius = look.dp(14f).toFloat()
        } else null
        text.layoutParams = LayoutParams(if (user) LayoutParams.WRAP_CONTENT else LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
            gravity = if (user) Gravity.END else Gravity.START
            setMargins(sideways, gap, sideways, gap)
        }
        if (user) text.maxWidth = (resources.displayMetrics.widthPixels * RowCache.USER_SHARE).toInt()
        // Once laid out, the long press the drawn row took is played again on the text, so the word under the finger
        // is the one selected, as in any text view.
        post { pressAt(x - text.left, y - text.top) }
    }

    private fun pressAt(x: Float, y: Float) {
        val now = SystemClock.uptimeMillis()
        val down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x, y, 0)
        text.onTouchEvent(down)
        text.performLongClick(x, y)
        // Lifted where it went down: the editor puts up the copy toolbar when the long press ends.
        val up = MotionEvent.obtain(now, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0)
        text.onTouchEvent(up)
        down.recycle()
        up.recycle()
    }
}
