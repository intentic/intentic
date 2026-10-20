package dev.intentic.app.conversation

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View
import dev.intentic.app.core.Spans

/**
 * A transcript row: draws a layout [RowCache] built, so measuring is reading its height and drawing is replaying its
 * lines. No TextView: no span watching, no editor, no second measure. A prompt sits in a bubble on the right. Where
 * the finger went down is kept, for the selectable stand-in a long press swaps in.
 */
@SuppressLint("ViewConstructor")
class RowView(context: Context, private val look: RowLook, private val bubbled: Boolean = true) : View(context) {
    private val bubble = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = look.bubble }
    private val bounds = RectF()
    private val padding = look.dp(RowCache.BUBBLE_PADDING)
    private val gap = look.dp(GAP)
    private val radius = look.dp(14f).toFloat()

    var touchX = 0f
        private set
    var touchY = 0f
        private set

    init {
        // Drawn text is no text to TalkBack: each row says its words as its description, and is one stop.
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        isFocusable = true
    }

    var row: Built? = null
        set(value) {
            val resized = field?.layout?.height != value?.layout?.height || field?.bubbleWidth != value?.bubbleWidth || field?.kind != value?.kind
            field = value
            contentDescription = value?.text
            if (resized) requestLayout()
            invalidate()
        }

    private val inBubble: Boolean get() = bubbled && row?.kind == Spans.VIEW_USER

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val text = row?.layout?.height ?: 0
        val height = if (inBubble) text + 2 * padding + 2 * gap else text + 2 * gap
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), height)
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            touchX = event.x
            touchY = event.y
        }
        return super.onTouchEvent(event)
    }

    override fun onDraw(canvas: Canvas) {
        val row = row ?: return
        if (inBubble) {
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

    companion object {
        const val GAP = 6f
    }
}
