package dev.intentic.app.conversation

import dev.intentic.app.core.Spans

/** The theme's colours a row's styles are drawn in, as ARGB. */
data class Inks(
    val content: Int,
    val muted: Int,
    val subtle: Int,
    val accent: Int,
    val link: Int,
    val danger: Int,
    val success: Int,
)

/** One style over `[start, end)` of a row's text: what the core's span kinds become, before any Android span exists. */
data class Mark(val start: Int, val end: Int, val style: Style, val value: Int = 0, val scale: Float = 1f)

enum class Style { BOLD, ITALIC, MONO, BACKGROUND, BLOCK, INK, UNDERLINE, SCALE, STRIKE, QUOTE }

private val HEADING_SCALES = floatArrayOf(1f, 1.4f, 1.25f, 1.12f, 1.05f, 1f, 1f)
private const val CODE_SCALE = 0.88f
private const val TOOL_SCALE = 0.9f

/**
 * The marks for a row's span quads, read from [from] in `spans` (Core.row puts the view kind first). Each quad is
 * `[start, end, kind, arg]` in UTF-16 offsets; one is clipped to [length] and dropped if empty, so a span that reached
 * past a text the core changed in between draws nothing rather than throwing. Kinds this app does not know are skipped.
 */
fun marksOf(spans: IntArray, from: Int, length: Int, inks: Inks): List<Mark> {
    val marks = ArrayList<Mark>((spans.size - from) / 2)
    var at = from
    while (at + 3 < spans.size) {
        val start = spans[at].coerceIn(0, length)
        val end = spans[at + 1].coerceIn(start, length)
        val arg = spans[at + 3]
        if (end > start) {
            add(marks, start, end, spans[at + 2], arg, inks)
        }
        at += 4
    }
    return marks
}

private fun add(marks: MutableList<Mark>, start: Int, end: Int, kind: Int, arg: Int, inks: Inks) {
    fun mark(style: Style, value: Int = 0, scale: Float = 1f) = marks.add(Mark(start, end, style, value, scale))
    when (kind) {
        Spans.BOLD -> mark(Style.BOLD)
        Spans.ITALIC -> mark(Style.ITALIC)
        Spans.CODE -> {
            mark(Style.MONO)
            mark(Style.BACKGROUND, arg)
        }
        Spans.BLOCK -> {
            mark(Style.MONO)
            mark(Style.SCALE, scale = CODE_SCALE)
            mark(Style.BLOCK, arg)
        }
        Spans.COLOR -> mark(Style.INK, arg)
        Spans.LINK -> {
            mark(Style.INK, inks.link)
            mark(Style.UNDERLINE)
        }
        Spans.HEADING -> {
            mark(Style.SCALE, scale = HEADING_SCALES[arg.coerceIn(1, 6)])
            mark(Style.BOLD)
        }
        Spans.TABLE -> {
            mark(Style.MONO)
            mark(Style.SCALE, scale = CODE_SCALE)
        }
        // A running call in the accent, a finished one quiet, a failed one in danger.
        Spans.TOOL -> {
            mark(Style.INK, when (arg) { 0 -> inks.accent; 2 -> inks.danger; else -> inks.muted })
            mark(Style.SCALE, scale = TOOL_SCALE)
        }
        Spans.STRIKE -> mark(Style.STRIKE)
        Spans.QUOTE -> mark(Style.QUOTE, inks.subtle)
        Spans.THINKING -> {
            mark(Style.INK, inks.muted)
            mark(Style.ITALIC)
        }
        // A checklist item: pending in the text's own ink, in progress in the accent, done quiet and struck.
        Spans.TODO -> when (arg) {
            1 -> mark(Style.INK, inks.accent)
            2 -> {
                mark(Style.INK, inks.muted)
                mark(Style.STRIKE)
            }
        }
        Spans.MUTED -> mark(Style.INK, inks.muted)
        Spans.TITLE -> mark(Style.BOLD)
    }
}
