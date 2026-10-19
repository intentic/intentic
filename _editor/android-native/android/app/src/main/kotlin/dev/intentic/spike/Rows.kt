package dev.intentic.spike

import android.os.Trace
import android.text.Layout
import android.text.StaticLayout
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.ceil

/** One row ready to draw: its text already parsed, highlighted, styled and broken into lines at the list's width. */
class Built(val version: Int, val role: Int, val layout: StaticLayout, val bubbleWidth: Int)

/**
 * The transcript's laid-out rows. Building one (Rust renders it, Kotlin styles it, StaticLayout breaks its lines) runs
 * on [workers] ahead of the scroll, so binding a row is a lookup; only a row nobody prefetched is built on the
 * caller's thread. A row the stream changed gets a new version and is rebuilt; until then its last layout is drawn.
 */
class Rows(private val handle: Long, private val look: Look, private val width: Int) {
    private val built = ConcurrentHashMap<Int, Built>()
    private val versions = ConcurrentHashMap<Int, Int>()
    private val pending = ConcurrentHashMap<Int, Int>()
    private val workers: ExecutorService = Executors.newFixedThreadPool(WORKERS) { task ->
        Thread({
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND)
            task.run()
        }, "spike-layout-${counter.incrementAndGet()}")
    }

    private fun version(index: Int): Int = versions[index] ?: 0

    /** The newest layout this row has, current or not; null when it has none yet. */
    fun latest(index: Int): Built? = built[index]

    fun current(index: Int): Boolean = built[index]?.version == version(index)

    /** Builds the row on the caller's thread and keeps it. */
    fun build(index: Int): Built {
        val version = version(index)
        Trace.beginSection("spike.build")
        try {
            val out = arrayOfNulls<String>(1)
            val spans = Core.render(handle, index, out)
            val role = Core.role(handle, index)
            val text = Spans.styled(out[0] ?: "", spans, look)
            val paint = look.paintFor(role)
            val available = if (role == Core.ROLE_USER) (width * USER_SHARE).toInt() - 2 * look.dp(BUBBLE_PADDING) else width
            val layout = StaticLayout.Builder.obtain(text, 0, text.length, paint, available)
                .setLineSpacing(0f, LINE_SPACING)
                .setIncludePad(false)
                .setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
                .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
                .build()
            var widest = 0f
            for (line in 0 until layout.lineCount) {
                widest = maxOf(widest, layout.getLineWidth(line))
            }
            val row = Built(version, role, layout, ceil(widest).toInt())
            built.merge(index, row) { old, new -> if (new.version >= old.version) new else old }
            return row
        } finally {
            Trace.endSection()
        }
    }

    /** Builds rows on the workers and calls [done] on a worker once each is kept. */
    fun buildAhead(indices: IntRange, done: ((Int) -> Unit)? = null) {
        for (index in indices) {
            val version = version(index)
            if (current(index) || pending.put(index, version) == version) {
                continue
            }
            workers.execute {
                try {
                    if (version(index) == version) {
                        build(index)
                        done?.invoke(index)
                    }
                } finally {
                    pending.remove(index, version)
                }
            }
        }
    }

    /** Builds [indices] on every worker at once and waits: the rows the first frame shows. */
    fun buildNow(indices: IntRange) {
        val futures: List<Future<*>> = indices.map { index -> workers.submit { build(index) } }
        futures.forEach { it.get() }
    }

    fun changed(index: Int) {
        versions.merge(index, 1, Int::plus)
    }

    fun close() {
        workers.shutdownNow()
    }

    private companion object {
        val counter = AtomicInteger()
        const val WORKERS = 3
        const val USER_SHARE = 0.82f
        const val BUBBLE_PADDING = 12f
        const val LINE_SPACING = 1.25f
    }
}
