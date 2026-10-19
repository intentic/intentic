package dev.intentic.spike

import android.content.Context
import android.text.TextPaint
import android.util.TypedValue

/** Colours and sizes, and one text paint per thread: a layout built off the main thread must not share a paint. */
class Look(context: Context) {
    private val metrics = context.resources.displayMetrics
    val canvas = context.getColor(R.color.canvas)
    val card = context.getColor(R.color.card)
    val content = context.getColor(R.color.content)
    val muted = context.getColor(R.color.muted)
    val accent = context.getColor(R.color.accent)

    fun dp(value: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, metrics).toInt()

    private fun sp(value: Float): Float = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value, metrics)

    private val body = ThreadLocal.withInitial {
        TextPaint(TextPaint.ANTI_ALIAS_FLAG).apply {
            color = content
            textSize = sp(15f)
        }
    }
    private val note = ThreadLocal.withInitial {
        TextPaint(TextPaint.ANTI_ALIAS_FLAG).apply {
            color = muted
            textSize = sp(13f)
        }
    }

    fun paintFor(role: Int): TextPaint = (if (role == Core.ROLE_NOTICE) note else body).get()!!
}
