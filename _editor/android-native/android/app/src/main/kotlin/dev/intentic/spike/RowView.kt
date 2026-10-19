package dev.intentic.spike

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.View

/**
 * A transcript row: draws a layout [Rows] built, so measuring is reading its height and drawing is replaying its
 * lines. No TextView: no span watching, no editor, no second measure. A prompt sits in a bubble on the right.
 */
class RowView(context: Context, private val look: Look) : View(context) {
    private val bubble = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = look.card }
    private val bounds = RectF()
    private val padding = look.dp(12f)
    private val gap = look.dp(8f)
    private val radius = look.dp(14f).toFloat()

    var row: Built? = null
        set(value) {
            val resized = field?.layout?.height != value?.layout?.height || field?.bubbleWidth != value?.bubbleWidth
            field = value
            if (resized) requestLayout()
            invalidate()
        }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val layout = row?.layout
        val text = layout?.height ?: 0
        val height = if (row?.role == Core.ROLE_USER) text + 2 * padding + 2 * gap else text + 2 * gap
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), height)
    }

    override fun onDraw(canvas: Canvas) {
        val row = row ?: return
        if (row.role == Core.ROLE_USER) {
            val right = width - paddingRight
            val left = right - row.bubbleWidth - 2 * padding
            bounds.set(left.toFloat(), gap.toFloat(), right.toFloat(), (height - gap).toFloat())
            canvas.drawRoundRect(bounds, radius, radius, bubble)
            canvas.translate((left + padding).toFloat(), (gap + padding).toFloat())
        } else {
            canvas.translate(paddingLeft.toFloat(), gap.toFloat())
        }
        row.layout.draw(canvas)
    }
}
