package dev.intentic.app.conversation

import android.content.Context
import android.graphics.Typeface
import android.text.TextPaint
import android.util.TypedValue
import androidx.core.content.res.ResourcesCompat
import dev.intentic.app.R
import dev.intentic.app.core.Spans
import kotlin.math.roundToInt

/**
 * What a row is drawn with: the theme's inks, the bundled faces, and one text paint per kind per thread, since a row
 * laid out on a worker must not share a paint with one the main thread is drawing.
 */
class RowLook(context: Context) {
    private val metrics = context.resources.displayMetrics
    val inks = Inks(
        content = context.getColor(R.color.content),
        muted = context.getColor(R.color.muted),
        subtle = context.getColor(R.color.subtle),
        accent = context.getColor(R.color.accent),
        link = context.getColor(R.color.link),
        danger = context.getColor(R.color.danger),
        success = context.getColor(R.color.success),
    )
    val bubble = context.getColor(R.color.card)
    val cardLine = context.getColor(R.color.line)
    val sans: Typeface = requireNotNull(ResourcesCompat.getFont(context, R.font.public_sans))
    val mono: Typeface = requireNotNull(ResourcesCompat.getFont(context, R.font.jetbrains_mono))

    fun dp(value: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, metrics).roundToInt()

    private fun sp(value: Float): Float = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value, metrics)

    private fun paint(size: Float, ink: Int) = ThreadLocal.withInitial {
        TextPaint(TextPaint.ANTI_ALIAS_FLAG).apply {
            typeface = sans
            textSize = sp(size)
            color = ink
        }
    }

    private val body = paint(15f, inks.content)
    private val notice = paint(13f, inks.muted)

    fun paintFor(kind: Int): TextPaint = (if (kind == Spans.VIEW_NOTICE) notice else body).get()!!
}
