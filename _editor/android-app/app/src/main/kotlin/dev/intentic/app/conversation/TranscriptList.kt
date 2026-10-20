package dev.intentic.app.conversation

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.ViewTreeObserver
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import dev.intentic.app.core.Core
import dev.intentic.app.core.EventRowsInner
import dev.intentic.app.core.RowChange
import dev.intentic.app.ui.Ui

/**
 * The conversation's list: a RecyclerView whose count and notifications follow Event.Rows exactly, over the layouts a
 * [RowCache] makes. It stays on the newest row while the reader is at the bottom, asks for the page above ([older])
 * when the top comes into view, and says once, from inside the frame that first draws rows, that it is drawing them
 * ([drawn]).
 */
class TranscriptList(
    context: Context,
    ui: Ui,
    private val look: RowLook,
    actions: CardActions,
    agent: String?,
    private val older: () -> Unit,
    private val drawn: (Int) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private val counter = RowCount()
    private val rows = TranscriptAdapter({ rowsFor() }, look, ui, actions)
    private val side = 2 * look.dp(TranscriptAdapter.SIDE)
    // Made now, at the screen's width, so the core's first rows can be laid out before the list is (early).
    @Volatile private var cache: RowCache? = RowCache(CoreRows(agent.orEmpty()), look, context.resources.displayMetrics.widthPixels - side)
    private var asking = false

    var agent: String? = agent
        set(value) {
            field = value
            cache?.close()
            cache = null
        }
    var live = false
        private set
    var more = false
        private set

    val view: RecyclerView = RecyclerView(context).apply {
        layoutManager = LinearLayoutManager(context).apply { stackFromEnd = true }
        adapter = rows
        itemAnimator = null
        setItemViewCacheSize(VIEW_CACHE)
        addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(view: RecyclerView, dx: Int, dy: Int) = askOlder()
        })
    }

    init {
        whenDrawn()
    }

    /**
     * On the core's event thread, before the main thread sees the event: the first Rows of this conversation starts the
     * workers on its last screen of rows, which on a cold start the main thread is still busy drawing an empty list for.
     */
    fun early(event: EventRowsInner) {
        if (event.agent == agent && event.change is RowChange.Reset) cache?.prepare(event.count.toInt(), FIRST_SCREEN)
    }

    fun apply(event: EventRowsInner) {
        live = event.live
        more = event.more
        asking = false
        val notice = counter.apply(event)
        val cache = rowsFor()
        // A row the stream changes is gathered and rebuilt once at the next frame, however many patches reach it before.
        if (notice is Notice.Changed && live) {
            cache.changed(notice.at, notice.count)
            for (index in notice.at until notice.at + notice.count) streamed.add(index)
            if (!framing) {
                framing = true
                Choreographer.getInstance().postFrameCallback(frame)
            }
            return
        }
        settle()
        val pinned = !view.canScrollVertically(1)
        rows.shifted(notice)
        rows.count = counter.count
        when (notice) {
            is Notice.All -> {
                if (!cache.prepared(notice.count)) cache.reset(notice.count)
                // The rows the first frame shows, laid out on every worker at once rather than one by one on this thread.
                cache.buildNow(notice.count - FIRST_SCREEN, notice.count)
                rows.notifyDataSetChanged()
                view.scrollToPosition(notice.count - 1)
            }
            is Notice.Inserted -> {
                cache.inserted(notice.at, notice.count)
                rows.notifyItemRangeInserted(notice.at, notice.count)
            }
            // A change outside a stream (a card answered): laid out again when the list binds it.
            is Notice.Changed -> {
                cache.changed(notice.at, notice.count)
                rows.notifyItemRangeChanged(notice.at, notice.count, REBUILT)
            }
            is Notice.Removed -> {
                cache.removed(notice.at, notice.count)
                rows.notifyItemRangeRemoved(notice.at, notice.count)
            }
        }
        // A row growing at the bottom needs no scroll: the list lays out from its end, so the rest move up. A new row
        // below the last one does.
        if (pinned && counter.count > 0) view.scrollToPosition(counter.count - 1)
        main.post(::askOlder)
    }

    private val streamed = java.util.TreeSet<Int>()
    private var framing = false
    private val frame = Choreographer.FrameCallback {
        framing = false
        settle()
    }

    // The streamed rows gathered since the last frame, each rebuilt once, here on the main thread in this frame before it
    // is drawn. Measured on a Galaxy S10 with the spike's bench (stream scenario, no late frames either way): a thread of
    // their own beside the frame cost 8.4 s of CPU, against 6.3 s here; the background workers, on the little cores,
    // landed rows frames late (the spike's finding).
    private fun settle() {
        if (streamed.isEmpty()) return
        val cache = rowsFor()
        for (index in streamed) {
            if (index >= rows.count) continue
            cache.build(index)
            rows.notifyItemChanged(index, REBUILT)
        }
        streamed.clear()
    }

    fun close() {
        cache?.close()
    }

    // The layouts for the list's width; made again if that width changes (a split screen resized).
    private fun rowsFor(): RowCache {
        val width = (view.width.takeIf { it > 0 } ?: view.resources.displayMetrics.widthPixels) - side
        val held = cache
        if (held != null && held.width == width) return held
        held?.close()
        val made = RowCache(CoreRows(agent.orEmpty()), look, width)
        made.reset(counter.count)
        cache = made
        // Rows already on screen were laid out at the old width: every one is bound again.
        if (held != null) view.post { rows.notifyDataSetChanged() }
        return made
    }

    // The page above, once the top is in view: older rows go in at 0, and the list keeps its place because it lays out
    // from its end (stackFromEnd), so rows put above what is on screen move nothing.
    private fun askOlder() {
        if (agent == null || !more || asking) return
        if ((view.layoutManager as LinearLayoutManager).findFirstVisibleItemPosition() in 0..OLDER_WITHIN) {
            asking = true
            older()
        }
    }

    private fun whenDrawn() {
        view.viewTreeObserver.addOnDrawListener(object : ViewTreeObserver.OnDrawListener {
            private var done = false

            override fun onDraw() {
                if (done || view.childCount == 0) return
                done = true
                // Within the frame, so its end is the end of a frame drawn after `drawn`: what Android's time to full
                // display waits for. Said after it, the screen would have to draw again, which a still one never does.
                drawn(counter.count)
                view.post { view.viewTreeObserver.removeOnDrawListener(this) }
            }
        })
    }

    private companion object {
        /** Rows laid out before the first frame: more than a phone's screen of them. */
        const val FIRST_SCREEN = 16
        const val VIEW_CACHE = 12
        /** How close to the top the first row on screen may be before the page above is asked for. */
        const val OLDER_WITHIN = 2
        val REBUILT = Any()
    }
}

/** Rows from the core's open conversation for [agent]. */
private class CoreRows(private val agent: String) : RowSource {
    override fun row(index: Int, out: Array<String?>): IntArray? = Core.row(agent, index, out)

    override fun card(index: Int): String? = Core.card(agent, index)

    override fun pageId(index: Int): String? = Core.pageId(agent, index)
}
