package dev.intentic.spike

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Spannable
import android.text.SpannableString
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.LineBackgroundSpan
import android.text.style.QuoteSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.UnderlineSpan

/** The span kinds of `core/src/render.rs`; change both together. */
object Spans {
    const val BOLD = 1
    const val ITALIC = 2
    const val CODE = 3
    const val BLOCK = 4
    const val COLOR = 5
    const val LINK = 6
    const val HEADING = 7
    const val TABLE = 8
    const val TOOL = 9
    const val STRIKE = 10
    const val QUOTE = 11

    private val HEADING_SIZES = floatArrayOf(1f, 1.5f, 1.3f, 1.15f, 1.05f, 1f, 1f)
    private const val FLAGS = Spanned.SPAN_EXCLUSIVE_EXCLUSIVE

    /** A fenced block's background, drawn across every line the block covers. */
    private class BlockBackground(private val color: Int) : LineBackgroundSpan {
        override fun drawBackground(
            canvas: Canvas, paint: Paint, left: Int, right: Int, top: Int, baseline: Int, bottom: Int,
            text: CharSequence, start: Int, end: Int, lineNumber: Int,
        ) {
            val previous = paint.color
            paint.color = color
            canvas.drawRect(left.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat(), paint)
            paint.color = previous
        }
    }

    fun styled(text: String, spans: IntArray, look: Look): Spannable {
        val styled = SpannableString(text)
        var at = 0
        while (at + 3 < spans.size) {
            val start = spans[at]
            val end = spans[at + 1]
            val arg = spans[at + 3]
            when (spans[at + 2]) {
                BOLD -> styled.setSpan(StyleSpan(Typeface.BOLD), start, end, FLAGS)
                ITALIC -> styled.setSpan(StyleSpan(Typeface.ITALIC), start, end, FLAGS)
                CODE -> {
                    styled.setSpan(TypefaceSpan("monospace"), start, end, FLAGS)
                    styled.setSpan(BackgroundColorSpan(arg), start, end, FLAGS)
                }
                BLOCK -> {
                    styled.setSpan(TypefaceSpan("monospace"), start, end, FLAGS)
                    styled.setSpan(RelativeSizeSpan(0.88f), start, end, FLAGS)
                    styled.setSpan(BlockBackground(arg), start, end, FLAGS)
                }
                COLOR -> styled.setSpan(ForegroundColorSpan(arg), start, end, FLAGS)
                LINK -> {
                    styled.setSpan(ForegroundColorSpan(look.accent), start, end, FLAGS)
                    styled.setSpan(UnderlineSpan(), start, end, FLAGS)
                }
                HEADING -> {
                    styled.setSpan(RelativeSizeSpan(HEADING_SIZES[arg.coerceIn(1, 6)]), start, end, FLAGS)
                    styled.setSpan(StyleSpan(Typeface.BOLD), start, end, FLAGS)
                }
                TABLE -> {
                    styled.setSpan(TypefaceSpan("monospace"), start, end, FLAGS)
                    styled.setSpan(RelativeSizeSpan(0.88f), start, end, FLAGS)
                }
                TOOL -> {
                    styled.setSpan(ForegroundColorSpan(if (arg == 0) look.accent else look.muted), start, end, FLAGS)
                    styled.setSpan(RelativeSizeSpan(0.9f), start, end, FLAGS)
                }
                STRIKE -> styled.setSpan(StrikethroughSpan(), start, end, FLAGS)
                QUOTE -> styled.setSpan(QuoteSpan(look.muted), start, end, FLAGS)
            }
            at += 4
        }
        return styled
    }
}
