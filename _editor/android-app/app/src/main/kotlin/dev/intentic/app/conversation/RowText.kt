package dev.intentic.app.conversation

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Spannable
import android.text.SpannableString
import android.text.Spanned
import android.text.TextPaint
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.LineBackgroundSpan
import android.text.style.MetricAffectingSpan
import android.text.style.QuoteSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.UnderlineSpan

private const val FLAGS = Spanned.SPAN_EXCLUSIVE_EXCLUSIVE

/**
 * The bundled code face. TypefaceSpan takes a Typeface only from API 28, so this sets it on the paint itself, with
 * the ligatures off as the web has them (tokens.css): `=>` reads as two characters in code, not an arrow.
 */
private class MonoSpan(private val face: Typeface) : MetricAffectingSpan() {
    override fun updateMeasureState(paint: TextPaint) = mono(paint)

    override fun updateDrawState(paint: TextPaint) = mono(paint)

    private fun mono(paint: TextPaint) {
        paint.typeface = face
        paint.fontFeatureSettings = NO_LIGATURES
    }

    private companion object {
        const val NO_LIGATURES = "'liga' 0, 'calt' 0"
    }
}

/** A fenced block's background, drawn across every line the block covers rather than only behind its glyphs. */
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

/** A row's text with its marks as Android spans: what both the drawn row and its selectable stand-in show. */
fun styled(text: String, marks: List<Mark>, look: RowLook): Spannable {
    val styled = SpannableString(text)
    for (mark in marks) {
        val span: Any = when (mark.style) {
            Style.BOLD -> StyleSpan(Typeface.BOLD)
            Style.ITALIC -> StyleSpan(Typeface.ITALIC)
            Style.MONO -> MonoSpan(look.mono)
            Style.BACKGROUND -> BackgroundColorSpan(mark.value)
            Style.BLOCK -> BlockBackground(mark.value)
            Style.INK -> ForegroundColorSpan(mark.value)
            Style.UNDERLINE -> UnderlineSpan()
            Style.SCALE -> RelativeSizeSpan(mark.scale)
            Style.STRIKE -> StrikethroughSpan()
            Style.QUOTE -> QuoteSpan(mark.value)
        }
        styled.setSpan(span, mark.start, mark.end, FLAGS)
    }
    return styled
}
