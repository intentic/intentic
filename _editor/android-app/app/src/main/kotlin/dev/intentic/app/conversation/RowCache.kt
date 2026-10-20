package dev.intentic.app.conversation

import android.annotation.SuppressLint
import android.os.Process
import android.os.Trace
import android.text.Layout
import android.text.Spannable
import android.text.StaticLayout
import dev.intentic.app.core.CardRow
import dev.intentic.app.core.Spans
import dev.intentic.app.core.Wire
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicIntegerArray
import java.util.concurrent.atomic.AtomicReferenceArray
import kotlin.math.ceil

/** Where rows come from: the core's open conversation (Core.row and Core.card), by index. */
interface RowSource {
    fun row(index: Int, out: Array<String?>): IntArray?

    fun card(index: Int): String?

    fun pageId(index: Int): String?
}

/** One row ready to draw: styled, broken into lines at the list's width, and its card's buttons' needs read. */
class Built(
    val version: Int,
    val kind: Int,
    val text: Spannable,
    val layout: StaticLayout,
    val bubbleWidth: Int,
    val card: CardRow?,
    /** The page a page row or a page's card opens: what `/agents/<agent>/pages/<id>` names. */
    val pageId: String?,
)

/**
 * The conversation's laid-out rows, the spike's arm A (`_editor/android-native`, Rows.kt): building a row (the core
 * renders it, Kotlin styles it, StaticLayout breaks its lines) runs on [WORKERS] background threads ahead of the
 * scroll, so binding is an array read. A row the core changed gets a new version and is rebuilt.
 *
 * The rows move: a page of older ones goes in at 0 and a sent row is replaced. Each such change swaps in a new set of
 * [Slots] (main thread only), and a worker stores what it built into the set it started from, so a layout made before
 * a move can never land at the wrong index: it lands in a set nobody reads any more.
 */
class RowCache(private val source: RowSource, private val look: RowLook, val width: Int) {
    private class Slots(val size: Int) {
        val built = AtomicReferenceArray<Built?>(size)
        val versions = AtomicIntegerArray(size)
        // The version queued for a worker, plus one; zero when none is.
        val queued = AtomicIntegerArray(size)
    }

    @Volatile private var slots = Slots(0)
    private val workers: ExecutorService = Executors.newFixedThreadPool(WORKERS) { task ->
        Thread({
            Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND)
            task.run()
        }, "row-layout")
    }

    val size: Int get() = slots.size

    /** The newest layout this row has, current or not. */
    fun latest(index: Int): Built? = slots.let { if (index in 0 until it.size) it.built[index] else null }

    fun current(index: Int): Boolean = slots.let { index in 0 until it.size && it.built[index]?.version == it.versions[index] }

    /** The row's current layout, built on the caller's thread when no worker has made it yet. */
    fun get(index: Int): Built = latest(index)?.takeIf { current(index) } ?: build(index)

    /** Builds the row on the caller's thread and keeps it. */
    fun build(index: Int): Built {
        Trace.beginSection("row.build")
        try {
            return make(index)
        } finally {
            Trace.endSection()
        }
    }

    // Layout's break strategy constants are LineBreaker's under other names (API 29); lint reads them as wrong.
    @SuppressLint("WrongConstant")
    private fun make(index: Int): Built {
        val set = slots
        val version = if (index in 0 until set.size) set.versions[index] else -1
        val out = arrayOfNulls<String>(1)
        Trace.beginSection("row.core")
        val spans = try {
            source.row(index, out)
        } finally {
            Trace.endSection()
        }
        val text = out[0].orEmpty()
        // A row the core no longer has (a change the list has not been told yet) draws empty, at a version that is
        // never current, so the next bind asks again.
        val kind = spans?.firstOrNull() ?: Spans.VIEW_ASSISTANT
        val styled = styled(text, if (spans == null) emptyList() else marksOf(spans, 1, text.length, look.inks), look)
        val user = kind == Spans.VIEW_USER
        val available = if (user) (width * USER_SHARE).toInt() - 2 * look.dp(BUBBLE_PADDING) else width - 2 * cardInset(kind)
        val layout = StaticLayout.Builder.obtain(styled, 0, styled.length, look.paintFor(kind), available.coerceAtLeast(1))
            .setLineSpacing(0f, LINE_SPACING)
            .setIncludePad(false)
            .setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
            .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
            .build()
        var widest = 0f
        if (user) {
            for (line in 0 until layout.lineCount) widest = maxOf(widest, layout.getLineWidth(line))
        }
        val card = if (kind == Spans.VIEW_CARD) source.card(index)?.let(Wire::decodeCard) else null
        val page = if (kind == Spans.VIEW_PAGE) source.pageId(index) else card?.pageId
        val row = Built(if (spans == null) -1 else version, kind, styled, layout, ceil(widest).toInt(), card, page)
        if (spans != null && index in 0 until set.size && (set.built[index]?.version ?: -1) <= version) {
            set.built.set(index, row)
        }
        return row
    }

    /** Queues the rows of `[from, until)` that are not current on the workers. */
    fun buildAhead(from: Int, until: Int) {
        val set = slots
        for (index in from.coerceAtLeast(0) until until.coerceAtMost(set.size)) {
            val version = set.versions[index]
            if (set.built[index]?.version == version || set.queued.getAndSet(index, version + 1) == version + 1) {
                continue
            }
            workers.execute {
                try {
                    if (slots === set && set.versions[index] == version) build(index)
                } finally {
                    set.queued.compareAndSet(index, version + 1, 0)
                }
            }
        }
    }

    /**
     * Builds what `[from, until)` lacks on every worker at once and waits: the rows a first frame shows. Rows a worker
     * already made (see [prepare]) are not made twice.
     */
    fun buildNow(from: Int, until: Int) {
        (from.coerceAtLeast(0) until until.coerceAtMost(size)).filterNot(::current).map { index -> workers.submit { build(index) } }.forEach { it.get() }
    }

    /**
     * A fresh cache's first [count] rows, as the core's first Rows event says them, on the core's event thread before
     * the main thread is free: the slots are made and the last screen of rows queued on the workers, so the list finds
     * them laid out when it is told. Only before anything is shown: a cache that holds rows is the main thread's.
     */
    fun prepare(count: Int, screen: Int) {
        if (slots.size != 0) return
        reset(count)
        preparedFor = count
        buildAhead(count - screen, count)
    }

    @Volatile private var preparedFor = -1

    /** Whether [prepare] made this cache's rows for a first [count]: then the list's own reset to it would undo them. */
    fun prepared(count: Int): Boolean = (preparedFor == count && slots.size == count).also { preparedFor = -1 }

    // Structural changes, main thread only, in the terms Event.Rows says them.

    fun reset(count: Int) {
        slots = Slots(count)
    }

    fun inserted(at: Int, count: Int) = move(slots.size + count) { old, index -> if (index < at) index else if (index >= at + count) index - count else -1 }

    fun removed(at: Int, count: Int) = move(slots.size - count) { _, index -> if (index < at) index else index + count }

    fun changed(at: Int, count: Int) {
        val set = slots
        for (index in at until (at + count).coerceAtMost(set.size)) set.versions.incrementAndGet(index)
    }

    // A new set of `size` slots, slot i holding what the old set held at `from(old, i)` (none for -1).
    private inline fun move(size: Int, from: (Slots, Int) -> Int) {
        val old = slots
        val next = Slots(size.coerceAtLeast(0))
        for (index in 0 until next.size) {
            val source = from(old, index)
            if (source in 0 until old.size) {
                next.built.set(index, old.built[source])
                next.versions.set(index, old.versions[source])
            }
        }
        slots = next
    }

    fun close() {
        workers.shutdownNow()
    }

    companion object {
        const val WORKERS = 3
        const val USER_SHARE = 0.82f
        const val BUBBLE_PADDING = 12f
        const val CARD_PADDING = 14f
        const val LINE_SPACING = 1.25f
    }

    private fun cardInset(kind: Int): Int = if (kind == Spans.VIEW_CARD || kind == Spans.VIEW_PAGE) look.dp(CARD_PADDING) else 0
}
